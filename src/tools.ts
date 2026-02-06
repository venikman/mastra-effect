import { createHash } from "node:crypto";
import * as Fs from "node:fs/promises";
import * as Path from "node:path";
import { Cause, Context, Data, Effect, Layer, Option } from "effect";

// NOTE: We intentionally avoid Zod in this repo code. Mastra tools are represented
// as plain "function tool" objects with JSON-Schema-like `parameters`, and we do
// lightweight runtime validation/coercion inside `execute`.

export type JsonSchema = {
  type: "object";
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
};

export type FunctionTool = {
  type: "function";
  name: string;
  description: string;
  parameters: JsonSchema;
  // Mastra passes a context as the second arg; we ignore it in this repo.
  execute: (input: unknown, _context?: unknown) => Promise<unknown>;
};

const makeTool = (tool: Omit<FunctionTool, "type">): FunctionTool => ({
  type: "function",
  ...tool,
});

export type ToolEvent =
  | {
      type: "tool:start";
      tool: string;
      input: unknown;
    }
  | {
      type: "tool:success";
      tool: string;
      durationMs: number;
      outputSummary: unknown;
    }
  | {
      type: "tool:error";
      tool: string;
      durationMs: number;
      error: unknown;
    };

export type EventLog = {
  emit: (event: ToolEvent) => Effect.Effect<void>;
};

export const EventLog = Context.GenericTag<EventLog>("EventLog");

export const EventLogLive = Layer.succeed(EventLog, {
  emit: (event) =>
    Effect.sync(() => {
      // Intentionally JSONL so it's easy to grep/pipe.
      console.log(JSON.stringify({ ts: new Date().toISOString(), ...event }));
    }),
} satisfies EventLog);

export const EventLogSilent = Layer.succeed(EventLog, {
  emit: () => Effect.void,
} satisfies EventLog);

export class ToolDeniedError extends Data.TaggedError("ToolDeniedError")<{
  tool: string;
  path: string;
  reason: string;
}> {}

export class ToolFsError extends Data.TaggedError("ToolFsError")<{
  tool: string;
  message: string;
  cause?: unknown;
}> {}

export class ToolInputError extends Data.TaggedError("ToolInputError")<{
  tool: string;
  message: string;
  input: unknown;
}> {}

const DEFAULT_MAX_FILES = 400;
const DEFAULT_MAX_FILE_BYTES = 20_000;
const DEFAULT_MAX_MATCHES = 50;

const sha256 = (input: string): string =>
  createHash("sha256").update(input).digest("hex").slice(0, 16);

const runOrThrow = async <A, E>(eff: Effect.Effect<A, E>): Promise<A> => {
  const exit = await Effect.runPromiseExit(eff);
  if (exit._tag === "Failure") {
    const err = Cause.failureOption(exit.cause);
    if (Option.isSome(err)) {
      throw err.value;
    }
    throw exit.cause;
  }
  return exit.value;
};

const isDeniedRelPath = (rel: string): { denied: boolean; reason?: string } => {
  const normalized = rel.split(Path.sep).join("/");
  const segments = normalized.split("/").filter(Boolean);
  const base = segments.at(-1) ?? normalized;

  if (segments.includes(".git"))
    return { denied: true, reason: "Reading .git is blocked" };
  if (segments.includes("node_modules"))
    return { denied: true, reason: "Reading node_modules is blocked" };
  if (segments.includes("output"))
    return { denied: true, reason: "Reading output is blocked" };

  if (base === ".env" || base.startsWith(".env."))
    return { denied: true, reason: "Reading .env is blocked" };
  if (base === "id_rsa" || base.startsWith("id_rsa."))
    return { denied: true, reason: "Reading SSH keys is blocked" };
  if (base.endsWith(".pem"))
    return { denied: true, reason: "Reading .pem files is blocked" };
  if (base.endsWith(".key"))
    return { denied: true, reason: "Reading .key files is blocked" };

  return { denied: false };
};

const resolveInsideRoot = (
  tool: string,
  rootAbs: string,
  userPath: string,
): Effect.Effect<{ abs: string; rel: string }, ToolDeniedError> =>
  Effect.gen(function* () {
    const abs = Path.resolve(rootAbs, userPath);
    const rel = Path.relative(rootAbs, abs);

    const escaped =
      rel === "" || rel === "."
        ? false
        : rel.startsWith("..") ||
          rel.split(Path.sep).includes("..") ||
          Path.isAbsolute(rel);

    if (escaped) {
      return yield* Effect.fail(
        new ToolDeniedError({
          tool,
          path: userPath,
          reason: "Path escapes target root",
        }),
      );
    }

    const denied = isDeniedRelPath(rel);
    if (denied.denied) {
      return yield* Effect.fail(
        new ToolDeniedError({
          tool,
          path: rel,
          reason: denied.reason ?? "Denied",
        }),
      );
    }

    return { abs, rel };
  });

const safeReadTextFile = (
  tool: string,
  absPath: string,
  maxBytes: number,
): Effect.Effect<{ content: string; truncated: boolean }, ToolFsError> =>
  Effect.tryPromise({
    try: async () => {
      const buf = await Fs.readFile(absPath);
      const truncated = buf.byteLength > maxBytes;
      const slice = truncated ? buf.subarray(0, maxBytes) : buf;
      return { content: slice.toString("utf8"), truncated };
    },
    catch: (cause) =>
      new ToolFsError({
        tool,
        message: cause instanceof Error ? cause.message : "Failed to read file",
        cause,
      }),
  });

const walkFiles = async (
  rootAbs: string,
  maxFiles: number,
): Promise<string[]> => {
  const files: string[] = [];
  const stack = [rootAbs];

  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) break;

    const entries = await Fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const abs = Path.join(dir, entry.name);
      const rel = Path.relative(rootAbs, abs);

      const denied = isDeniedRelPath(rel);
      if (denied.denied) continue;

      if (entry.isDirectory()) {
        stack.push(abs);
        continue;
      }

      if (entry.isFile()) {
        files.push(rel);
        if (files.length >= maxFiles) return files.sort();
      }
    }
  }

  return files.sort();
};

const listFilesEffect = (rootAbs: string, maxFiles: number) =>
  Effect.tryPromise({
    try: async () => ({
      root: rootAbs,
      files: await walkFiles(rootAbs, maxFiles),
    }),
    catch: (cause) =>
      new ToolFsError({
        tool: "listFiles",
        message:
          cause instanceof Error ? cause.message : "Failed to list files",
        cause,
      }),
  });

const readFileEffect = (rootAbs: string, relPath: string, maxBytes: number) =>
  Effect.gen(function* () {
    const resolved = yield* resolveInsideRoot("readFile", rootAbs, relPath);
    const file = yield* safeReadTextFile("readFile", resolved.abs, maxBytes);
    return {
      root: rootAbs,
      path: resolved.rel,
      content: file.content,
      truncated: file.truncated,
    };
  });

const searchTextEffect = (rootAbs: string, query: string, maxMatches: number) =>
  Effect.gen(function* () {
    const listed = yield* listFilesEffect(rootAbs, DEFAULT_MAX_FILES);
    const matches: Array<{ path: string; line: number; preview: string }> = [];

    for (const rel of listed.files) {
      if (matches.length >= maxMatches) break;

      // Skip obvious binaries by extension (minimal heuristic)
      if (
        /\.(png|jpg|jpeg|gif|webp|ico|zip|gz|tgz|jar|pdf|woff2?)$/i.test(rel)
      ) {
        continue;
      }

      const resolved = yield* resolveInsideRoot("searchText", rootAbs, rel);
      const file = yield* safeReadTextFile("searchText", resolved.abs, 200_000);

      const lines = file.content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (matches.length >= maxMatches) break;
        const line = lines[i] ?? "";
        if (!line.includes(query)) continue;

        matches.push({
          path: rel,
          line: i + 1,
          preview: line.slice(0, 200),
        });
      }
    }

    return { root: rootAbs, query, matches };
  });

const withToolLogging = <A, E>(
  log: EventLog,
  tool: string,
  input: unknown,
  eff: Effect.Effect<A, E>,
  outputSummary: (a: A) => unknown,
): Effect.Effect<A, E> =>
  Effect.gen(function* () {
    yield* log.emit({ type: "tool:start", tool, input });
    const startedAt = yield* Effect.sync(() => Date.now());
    const exit = yield* Effect.exit(eff);
    const durationMs = (yield* Effect.sync(() => Date.now())) - startedAt;

    if (exit._tag === "Failure") {
      const cause = exit.cause;
      yield* log.emit({ type: "tool:error", tool, durationMs, error: cause });
      return yield* Effect.failCause(cause);
    }

    const value = exit.value;
    yield* log.emit({
      type: "tool:success",
      tool,
      durationMs,
      outputSummary: outputSummary(value),
    });
    return value;
  });

export const makeRepoTools = (rootDir: string) =>
  Effect.gen(function* () {
    const log = yield* EventLog;
    const rootAbs = Path.resolve(rootDir);

    const listFiles = makeTool({
      name: "listFiles",
      description: "List files under the target directory (safe subset).",
      parameters: {
        type: "object",
        properties: {
          max: {
            type: "integer",
            minimum: 1,
            description: "Maximum number of files to return",
          },
        },
        additionalProperties: false,
      },
      execute: async (input) => {
        const obj =
          typeof input === "object" && input !== null
            ? (input as Record<string, unknown>)
            : {};
        const max = obj.max;
        const maxFiles =
          typeof max === "number" && Number.isFinite(max) && max > 0
            ? Math.floor(max)
            : DEFAULT_MAX_FILES;

        return await runOrThrow(
          withToolLogging(
            log,
            "listFiles",
            { max: maxFiles },
            listFilesEffect(rootAbs, maxFiles),
            (out) => ({
              fileCount: out.files.length,
              sample: out.files.slice(0, 20),
            }),
          ),
        );
      },
    });

    const searchText = makeTool({
      name: "searchText",
      description:
        "Search for a string in text files under the target directory. Returns matching lines (capped).",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            minLength: 1,
            description: "String to search for",
          },
          maxMatches: {
            type: "integer",
            minimum: 1,
            description: "Maximum matches to return",
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
      execute: async (input) => {
        const obj =
          typeof input === "object" && input !== null
            ? (input as Record<string, unknown>)
            : null;
        const query = obj?.query;
        if (typeof query !== "string" || query.trim().length === 0) {
          throw new ToolInputError({
            tool: "searchText",
            message: "Invalid input: expected { query: string }",
            input,
          });
        }

        const maxMatchesRaw = obj?.maxMatches;
        const maxMatches =
          typeof maxMatchesRaw === "number" &&
          Number.isFinite(maxMatchesRaw) &&
          maxMatchesRaw > 0
            ? Math.floor(maxMatchesRaw)
            : DEFAULT_MAX_MATCHES;

        return await runOrThrow(
          withToolLogging(
            log,
            "searchText",
            { query, maxMatches },
            searchTextEffect(rootAbs, query, maxMatches),
            (out) => ({
              matchCount: out.matches.length,
              sample: out.matches.slice(0, 10),
            }),
          ),
        );
      },
    });

    const readFile = makeTool({
      name: "readFile",
      description:
        "Read a UTF-8 text file under the target directory (safe subset). Returns truncated content if needed.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            minLength: 1,
            description: "File path relative to target directory",
          },
          maxBytes: {
            type: "integer",
            minimum: 1,
            description: "Maximum bytes to read (truncates)",
          },
        },
        required: ["path"],
        additionalProperties: false,
      },
      execute: async (input) => {
        const obj =
          typeof input === "object" && input !== null
            ? (input as Record<string, unknown>)
            : null;
        const path = obj?.path;
        if (typeof path !== "string" || path.trim().length === 0) {
          throw new ToolInputError({
            tool: "readFile",
            message: "Invalid input: expected { path: string }",
            input,
          });
        }

        const maxBytesRaw = obj?.maxBytes;
        const maxBytes =
          typeof maxBytesRaw === "number" &&
          Number.isFinite(maxBytesRaw) &&
          maxBytesRaw > 0
            ? Math.floor(maxBytesRaw)
            : DEFAULT_MAX_FILE_BYTES;

        return await runOrThrow(
          withToolLogging(
            log,
            "readFile",
            { path, maxBytes },
            readFileEffect(rootAbs, path, maxBytes),
            (out) => ({
              path: out.path,
              bytes: out.content.length,
              truncated: out.truncated,
              sha256_16: sha256(out.content),
            }),
          ),
        );
      },
    });

    // ToolsInput type comes from @mastra/core; we keep runtime compatibility here
    // while staying Zod-free by providing JSON-schema-like tool parameters.
    return { listFiles, searchText, readFile } as const;
  });
