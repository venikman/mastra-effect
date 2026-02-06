/**
 * Sandboxed file-system tools for LLM agents.
 *
 * Provides three tools — listFiles, readFile, searchText — that an LLM can
 * call to explore a repository. All paths are confined to a root directory;
 * sensitive files (.env, keys, node_modules) are blocked by a deny list.
 */
import { createHash } from "node:crypto";
import * as Fs from "node:fs/promises";
import * as Path from "node:path";

import { Data, Effect, Layer } from "effect";
import { runOrThrow } from "./effect-utils.js";

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
  execute: (input: unknown, _context?: unknown) => Promise<unknown>;
};

const makeTool = (tool: Omit<FunctionTool, "type">): FunctionTool => ({
  type: "function",
  ...tool,
});

export type ToolEvent =
  | { type: "tool:start"; tool: string; input: unknown }
  | {
      type: "tool:success";
      tool: string;
      durationMs: number;
      outputSummary: unknown;
    }
  | { type: "tool:error"; tool: string; durationMs: number; error: unknown };

export class EventLog extends Effect.Service<EventLog>()("EventLog", {
  accessors: true,
  succeed: {
    emit: (event: ToolEvent) => Effect.log("tool event", { event }),
  },
}) {}

export const EventLogLive = EventLog.Default;

export const EventLogSilent = Layer.succeed(
  EventLog,
  EventLog.make({ emit: () => Effect.void }),
);

// Effect's Data.TaggedError gives us typed, pattern-matchable errors for free.
// Each class below carries a discriminant `_tag` so callers can match on it:
//   if (error._tag === "ToolDeniedError") { /* handle denied */ }
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

// Returns { denied, reason } instead of throwing so callers can decide how to
// handle denied paths — some log a warning, others fail the whole operation.
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

const resolveInsideRoot = Effect.fn("resolveInsideRoot")(function* (
  tool: string,
  rootAbs: string,
  userPath: string,
) {
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

const isErrnoException = (cause: unknown): cause is NodeJS.ErrnoException =>
  typeof cause === "object" &&
  cause !== null &&
  "code" in cause &&
  typeof (cause as any).code === "string";

const ensureRealpathInsideRoot = (
  tool: string,
  rootAbs: string,
  absPath: string,
  userPath: string,
): Effect.Effect<void, ToolDeniedError | ToolFsError> =>
  Effect.tryPromise({
    try: async () => {
      const rootReal = await Fs.realpath(rootAbs);

      let targetReal: string | null = null;
      try {
        targetReal = await Fs.realpath(absPath);
      } catch (cause) {
        // Let the actual file read report ENOENT for nicer error messages.
        if (isErrnoException(cause) && cause.code === "ENOENT") return;
        throw cause;
      }

      if (!targetReal) return;

      const rel = Path.relative(rootReal, targetReal);
      const escaped =
        rel === "" || rel === "."
          ? false
          : rel.startsWith("..") ||
            rel.split(Path.sep).includes("..") ||
            Path.isAbsolute(rel);

      if (escaped) {
        throw new ToolDeniedError({
          tool,
          path: userPath,
          reason: "Path resolves outside target root",
        });
      }
    },
    catch: (cause) => {
      if (cause instanceof ToolDeniedError) return cause;
      return new ToolFsError({
        tool,
        message:
          cause instanceof Error ? cause.message : "Failed to resolve path",
        cause,
      });
    },
  });

const SKIP_DIRS = new Set(["node_modules", ".git", "output"]);

/** Recursively walk `dir`, skipping SKIP_DIRS and symlinks. */
const walkDir = (
  rootAbs: string,
  dir: string,
): Effect.Effect<string[], ToolFsError> =>
  Effect.tryPromise({
    try: async () => {
      const entries = await Fs.readdir(dir, { withFileTypes: true });
      const files: string[] = [];
      for (const entry of entries) {
        if (SKIP_DIRS.has(entry.name)) continue;
        if (entry.isSymbolicLink()) continue;
        const full = Path.join(dir, entry.name);
        if (entry.isDirectory()) {
          // Effect.runPromise is safe here — walkDir's only error is ToolFsError
          // which we let bubble up through the outer tryPromise catch.
          const sub = await Effect.runPromise(walkDir(rootAbs, full));
          files.push(...sub);
        } else if (entry.isFile()) {
          files.push(Path.relative(rootAbs, full));
        }
      }
      return files;
    },
    catch: (cause) =>
      new ToolFsError({
        tool: "listFiles",
        message:
          cause instanceof Error ? cause.message : "Failed to walk directory",
        cause,
      }),
  });

/** List files under rootAbs, filtering through the deny list. */
const listFilesEffect = Effect.fn("listFiles")(function* (
  rootAbs: string,
  maxFiles: number,
) {
  const all = yield* walkDir(rootAbs, rootAbs);
  const files = all
    .filter((rel) => !isDeniedRelPath(rel).denied)
    .sort()
    .slice(0, maxFiles);
  return { root: rootAbs, files };
});

const readFileEffect = Effect.fn("readFile")(function* (
  rootAbs: string,
  relPath: string,
  maxBytes: number,
) {
  const resolved = yield* resolveInsideRoot("readFile", rootAbs, relPath);
  yield* ensureRealpathInsideRoot(
    "readFile",
    rootAbs,
    resolved.abs,
    resolved.rel,
  );
  const file = yield* safeReadTextFile("readFile", resolved.abs, maxBytes);
  return {
    root: rootAbs,
    path: resolved.rel,
    content: file.content,
    truncated: file.truncated,
  };
});

const searchTextEffect = Effect.fn("searchText")(function* (
  rootAbs: string,
  query: string,
  maxMatches: number,
) {
  const listed = yield* listFilesEffect(rootAbs, DEFAULT_MAX_FILES);
  const matches: Array<{ path: string; line: number; preview: string }> = [];

  for (const rel of listed.files) {
    if (matches.length >= maxMatches) break;
    if (/\.(png|jpg|jpeg|gif|webp|ico|zip|gz|tgz|jar|pdf|woff2?)$/i.test(rel))
      continue;

    const resolved = yield* resolveInsideRoot("searchText", rootAbs, rel);
    const file = yield* safeReadTextFile("searchText", resolved.abs, 200_000);

    const lines = file.content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (matches.length >= maxMatches) break;
      const line = lines[i] ?? "";
      if (!line.includes(query)) continue;
      matches.push({ path: rel, line: i + 1, preview: line.slice(0, 200) });
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
      yield* log.emit({
        type: "tool:error",
        tool,
        durationMs,
        error: exit.cause,
      });
      return yield* Effect.failCause(exit.cause);
    }

    yield* log.emit({
      type: "tool:success",
      tool,
      durationMs,
      outputSummary: outputSummary(exit.value),
    });
    return exit.value;
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

    return { listFiles, searchText, readFile } as const;
  });
