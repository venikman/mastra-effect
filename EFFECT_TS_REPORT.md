# Effect-TS Technical Report

This report documents how Effect-TS is used in the mastra-effect project, covering core concepts, dependency injection, error handling, async patterns, Mastra AI integration, and testing strategies.

## Diagrams Index

- 1.1 Effect type mental model
- 2.2 Layered DI (Context + Layer)
- 2.6 How `provide` satisfies `R`
- 2.6 `provideMerge` (pre-wiring layer dependencies)
- 3.4 Effect -> Exit -> throw/return (`runOrThrow`)
- 3.5 Exit for logging + re-propagation (`withToolLogging`)
- 4.2 Retry decision flow (Schedule)
- 4.3 `withTimeout(fetch)` (AbortController + upstream signal)
- 5.2 Repo tool safety pipeline (deny rules + root sandbox)
- 5.4 Tool loop (Agent <-> Model <-> Tools)

---

## 1. Effect-TS Core Concepts

### 1.1 The Effect Type

`Effect<A, E, R>` is the central type representing a computation that:

- **A** - Succeeds with a value of type A
- **E** - May fail with an error of type E
- **R** - Requires an environment/context of type R

**Diagram (mental model):**

```text
Environment R
     |
     | provided via Layer / Effect.provide
     v
Effect<A, E, R>
  |-- success --> A (value)
  `-- failure --> E (typed error)
```

Key imports used throughout this codebase:

```typescript
import {
  Effect,
  Context,
  Layer,
  Data,
  Cause,
  Option,
  Schedule,
  Duration,
} from "effect";
```

### 1.2 Effect.gen - Generator-based Composition

The primary composition pattern uses generators with `yield*`. This allows writing async code that looks synchronous while maintaining full type safety.

From `src/config.ts`:

```typescript
export const readAppConfig = Effect.gen(function* () {
  const grokKey = yield* readRequiredEnv("GROK_KEY");
  const grokModel = yield* readRequiredEnv("GROK_MODEL");

  const baseUrl = normalizeBaseUrl(
    process.env.OPENROUTER_BASE_URL?.trim() || "https://openrouter.ai/api/v1",
  );

  const logLevel = parseLogLevel(process.env.LOG_LEVEL);
  const demoTargetDir = process.env.DEMO_TARGET_DIR?.trim() || ".";
  const demoQuestion = process.env.DEMO_QUESTION?.trim() || undefined;

  return {
    grokKey,
    grokModel,
    baseUrl,
    logLevel,
    demoTargetDir,
    demoQuestion,
  } satisfies AppConfig;
});
```

The `yield*` operator both accesses services from context AND sequences effectful operations. When `yield*` encounters an Effect that fails, execution stops and the error propagates.

From `src/mastra.ts` - building a model with dependencies:

```typescript
export const makeOpenRouterLanguageModelV1 = Effect.gen(function* () {
  const cfg = yield* AppConfig; // Access AppConfig service from context
  const client = yield* OpenRouterClient; // Access OpenRouterClient service

  const doGenerate: LanguageModelV1["doGenerate"] = async (options) => {
    // ... implementation using cfg and client
  };

  const model: MastraLegacyLanguageModel = {
    specificationVersion: "v1",
    provider: "openrouter",
    modelId: cfg.grokModel,
    // ...
  };

  return model;
});
```

### 1.3 Effect.pipe - Functional Composition

The `pipe` method chains operations in a readable, left-to-right flow:

```typescript
program.pipe(
  Effect.provide(LiveLayers),
  Effect.retry(retrySchedule),
  Effect.timeout(Duration.seconds(60)),
);
```

From `src/openrouter.ts`:

```typescript
return {
  chatCompletions: (body) => request(body).pipe(Effect.retry(retrySchedule)),
} satisfies OpenRouterClient;
```

### 1.4 Effect Constructors

The codebase uses several Effect constructors:

**Effect.succeed** - Wrap a pure value:

```typescript
return Effect.succeed(trimmed);
```

**Effect.fail** - Create a failed effect with a typed error:

```typescript
return Effect.fail(
  new ConfigError({
    key,
    message: `Missing required env var ${key}`,
  }),
);
```

**Effect.sync** - Wrap a synchronous computation:

```typescript
Effect.sync(() => process.env[key]);
```

**Effect.tryPromise** - Wrap a Promise with error handling:

```typescript
Effect.tryPromise({
  try: async () => {
    const resp = await withTimeout(url, init, TIMEOUT_MS);
    // ...
  },
  catch: (e) => {
    if (e instanceof OpenRouterHttpError) return e;
    return new OpenRouterNetworkError({
      message: e instanceof Error ? e.message : "Network error",
      cause: e,
    });
  },
});
```

**Effect.flatMap** - Sequential composition:

```typescript
const readRequiredEnv = (key: string) =>
  Effect.sync(() => process.env[key]).pipe(
    Effect.flatMap((value) => {
      const trimmed = value?.trim() ?? "";
      if (trimmed.length === 0) {
        return Effect.fail(
          new ConfigError({ key, message: `Missing required env var ${key}` }),
        );
      }
      return Effect.succeed(trimmed);
    }),
  );
```

### 1.5 Effect.fn - Traced Functions

`Effect.fn` creates a function that automatically wraps its body in a tracing span. This enables observability without manual `Effect.withSpan` calls:

```typescript
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
```

Key points:

- The span name (`"readFile"`) appears in traces and is used for filtering/grouping
- The generator function receives arguments and uses `yield*` just like `Effect.gen`
- Unlike `Effect.gen`, `Effect.fn` returns a _function_ (not an Effect), so it's called as `readFileEffect(root, path, max)`
- Do NOT annotate the generator's return type — let TypeScript infer it

Used in this codebase for: `resolveInsideRoot`, `readFileEffect`, `searchTextEffect`.

---

## 2. Dependency Injection (Context + Layer)

### 2.1 Service Definition Patterns

This codebase uses two patterns depending on the service type:

**Pattern A: `Context.GenericTag` (plain config data)**

For services that are just data (no Effect-returning methods):

```typescript
// src/config.ts
export type AppConfig = {
  grokKey: string;
  grokModel: string;
  baseUrl: string;
  logLevel: LogLevelName;
  demoTargetDir: string;
  demoQuestion: string | undefined;
};

export const AppConfig = Context.GenericTag<AppConfig>("AppConfig");
export const AppConfigLive = Layer.effect(AppConfig, readAppConfig);
```

**Pattern B: `Effect.Service` (behavioral services)**

For services with Effect-returning methods, `Effect.Service` combines the tag, type, and default layer in a single class definition:

```typescript
// src/tools.ts
export class EventLog extends Effect.Service<EventLog>()("EventLog", {
  accessors: true,
  succeed: {
    emit: (event: ToolEvent) => Effect.log("tool event", { event }),
  },
}) {}

export const EventLogLive = EventLog.Default;
```

Key benefits of `Effect.Service`:

- **Single definition site**: tag + type + default implementation in one class
- **`accessors: true`**: generates static methods (e.g. `EventLog.emit(...)`) for direct use without `yield*`
- **`.make()`**: creates instances for test doubles: `EventLog.make({ emit: () => Effect.void })`
- **`.Default`**: the default Layer, ready to provide

For services built dynamically (depending on other services), use the `effect:` option:

```typescript
// src/openrouter.ts
export class OpenRouterClient extends Effect.Service<OpenRouterClient>()(
  "OpenRouterClient",
  { effect: buildOpenRouterClient },
) {}
```

### 2.2 Services in This Codebase

| Service            | File                | Pattern              | Layer Type                              |
| ------------------ | ------------------- | -------------------- | --------------------------------------- |
| `AppConfig`        | `src/config.ts`     | `Context.GenericTag` | `Layer.effect` (async)                  |
| `OpenRouterClient` | `src/openrouter.ts` | `Effect.Service`     | `effect:` (async, depends on AppConfig) |
| `EventLog`         | `src/tools.ts`      | `Effect.Service`     | `succeed:` (sync)                       |

**Diagram: Layered DI (Context + Layer)**

```text
Layers produce services (Context tags):

  AppConfigLive         ----->  [AppConfig]
  EventLogLive          ----->  [EventLog]
  OpenRouterClientLive  ----->  [OpenRouterClient]

Dependencies ("requires"):

  OpenRouterClientLive requires [AppConfig]
  makeOpenRouterLanguageModelV1 requires [AppConfig] + [OpenRouterClient]
  makeRepoTools requires [EventLog]
```

### 2.3 OpenRouterClient Service

From `src/openrouter.ts` — uses `Effect.Service` with the `effect:` option for dynamic construction:

```typescript
// Build function (depends on AppConfig via yield*)
const buildOpenRouterClient = Effect.gen(function* () {
  const cfg = yield* AppConfig;
  const url = `${cfg.baseUrl}/chat/completions`;

  const request = (body: OpenRouterChatCompletionRequest) =>
    Effect.tryPromise({
      /* ... */
    });

  const schedule = retrySchedule<OpenRouterError>({
    /* ... */
  });

  return {
    chatCompletions: (body: OpenRouterChatCompletionRequest) =>
      request(body).pipe(Effect.retry(schedule)),
  };
});

// Service class — tag, type, and default layer in one
export class OpenRouterClient extends Effect.Service<OpenRouterClient>()(
  "OpenRouterClient",
  { effect: buildOpenRouterClient },
) {}

export const OpenRouterClientLive = OpenRouterClient.Default;
```

Test doubles use `OpenRouterClient.make(...)`:

```typescript
const fakeClient = OpenRouterClient.make({
  chatCompletions: (body) =>
    Effect.sync(() => ({ body: mockResp, headers: {} })),
});
Layer.succeed(OpenRouterClient, fakeClient);
```

### 2.4 EventLog Service

From `src/tools.ts` — uses `Effect.Service` with `accessors: true` and `Effect.log`:

```typescript
export class EventLog extends Effect.Service<EventLog>()("EventLog", {
  accessors: true,
  succeed: {
    emit: (event: ToolEvent) => Effect.log("tool event", { event }),
  },
}) {}

export const EventLogLive = EventLog.Default;

// Silent layer for testing
export const EventLogSilent = Layer.succeed(
  EventLog,
  EventLog.make({ emit: () => Effect.void }),
);
```

The default implementation uses `Effect.log` (integrated with Effect's runtime log level and span context) instead of `console.log`. Test doubles use `EventLog.make(...)` to satisfy the `_tag` property required by `Effect.Service` classes.

### 2.5 Accessing Services

Inside `Effect.gen`, use `yield*` with the Context tag:

```typescript
Effect.gen(function* () {
  const cfg = yield* AppConfig; // Type: AppConfig
  const client = yield* OpenRouterClient; // Type: OpenRouterClient
  const log = yield* EventLog; // Type: EventLog
});
```

### 2.6 Providing Layers

**Single layer:**

```typescript
program.pipe(Effect.provide(AppConfigLive));
```

**Diagram: How `provide` Satisfies R**

```text
Before providing:

  program : Effect<A, E, AppConfig>
                     ^ needs this environment

After providing:

  program.pipe(Effect.provide(AppConfigLive)) : Effect<A, E, never>
                                               ^ no environment required

Intuition:
  Layer builds a runtime value for a Context tag, and `provide(...)` attaches it
  to the Effect so `yield* AppConfig` can succeed at runtime.
```

**Multiple layers with dependencies:**

From `src/mastra/index.ts`:

```typescript
const ConfigLayer = USE_MOCK
  ? Layer.succeed(AppConfig, mockConfig)
  : AppConfigLive;
const ClientLayer = USE_MOCK
  ? Layer.succeed(OpenRouterClient, createSmartMockClient()) // createSmartMockClient returns OpenRouterClient.make(...)
  : OpenRouterClientLive;

const LiveLayers = Layer.mergeAll(
  Layer.provideMerge(ConfigLayer)(ClientLayer),
  EventLogLive,
);
```

The `Layer.provideMerge(ConfigLayer)(ClientLayer)` pattern provides `AppConfig` to `OpenRouterClientLive` (or the mock client), since the OpenRouter client depends on configuration.

**Diagram: `provideMerge` (Pre-wiring Layer Dependencies)**

```text
ConfigLayer produces: [AppConfig]
ClientLayer requires: [AppConfig]  -> produces: [OpenRouterClient]

Layer.provideMerge(ConfigLayer)(ClientLayer):
  - runs ConfigLayer
  - feeds [AppConfig] into ClientLayer
  - outputs a combined layer that provides both:
      [AppConfig] + [OpenRouterClient]
```

### 2.7 Layer Composition Functions

- `Layer.succeed(Tag, value)` - Create a synchronous layer from a value
- `Layer.effect(Tag, effect)` - Create an async layer from an Effect
- `Layer.mergeAll(...)` - Combine independent layers
- `Layer.provideMerge(dep)(layer)` - Create a layer that has its dependency satisfied

---

## 3. Error Handling

### 3.1 Tagged Errors (Data.TaggedError)

Effect-TS uses discriminated unions for typed errors. Each error type extends `Data.TaggedError`:

From `src/config.ts`:

```typescript
export class ConfigError extends Data.TaggedError("ConfigError")<{
  key: string;
  message: string;
}> {}
```

From `src/openrouter.ts`:

```typescript
export class OpenRouterNetworkError extends Data.TaggedError(
  "OpenRouterNetworkError",
)<{
  message: string;
  cause?: unknown;
}> {}

export class OpenRouterHttpError extends Data.TaggedError(
  "OpenRouterHttpError",
)<{
  status: number;
  statusText: string;
  bodyText: string;
}> {}

export class OpenRouterParseError extends Data.TaggedError(
  "OpenRouterParseError",
)<{
  message: string;
  bodyText: string;
}> {}

// Union type for all OpenRouter errors
export type OpenRouterError =
  | OpenRouterNetworkError
  | OpenRouterHttpError
  | OpenRouterParseError;
```

From `src/tools.ts`:

```typescript
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
```

From `src/mastra.ts`:

```typescript
export class ModelAdapterError extends Data.TaggedError("ModelAdapterError")<{
  message: string;
  cause?: unknown;
}> {}
```

### 3.2 Creating and Propagating Errors

**Fail with a typed error:**

```typescript
Effect.fail(new ConfigError({ key: "GROK_KEY", message: "Missing" }));
```

**In tryPromise catch handler:**

```typescript
Effect.tryPromise({
  try: () => fetch(url),
  catch: (e) => {
    if (e instanceof OpenRouterHttpError) return e;
    return new OpenRouterNetworkError({ message: String(e), cause: e });
  },
});
```

**Conditional error in Effect.gen:**

```typescript
Effect.gen(function* () {
  const abs = Path.resolve(rootAbs, userPath);
  const rel = Path.relative(rootAbs, abs);

  if (escaped) {
    return yield* Effect.fail(
      new ToolDeniedError({
        tool,
        path: userPath,
        reason: "Path escapes target root",
      }),
    );
  }
  // ...
});
```

### 3.3 Exit and Cause

`Effect.runPromiseExit` returns an `Exit<A, E>` which captures the full result:

```typescript
const exit = await Effect.runPromiseExit(program);

if (exit._tag === "Success") {
  return exit.value; // Type: A
}

if (exit._tag === "Failure") {
  // exit.cause contains the full error chain
  const err = Cause.failureOption(exit.cause);
  if (Option.isSome(err)) {
    // err.value is the typed error (ConfigError | OpenRouterHttpError | ...)
    console.log(err.value._tag); // "ConfigError", "OpenRouterHttpError", etc.
  }
}
```

### 3.4 The runOrThrow Bridge Pattern

This pattern bridges Effect to Promise-based APIs (required for Mastra integration):

From `src/tools.ts` and `src/mastra.ts`:

```typescript
const runOrThrow = async <A, E>(eff: Effect.Effect<A, E>): Promise<A> => {
  const exit = await Effect.runPromiseExit(eff);
  if (exit._tag === "Failure") {
    const err = Cause.failureOption(exit.cause);
    if (Option.isSome(err)) {
      throw err.value; // Throw the typed error
    }
    throw exit.cause; // Throw the full cause if no simple failure
  }
  return exit.value;
};
```

**Diagram: Effect -> Exit -> Throw / Return**

```text
Effect<A, E>
  |
  v
Effect.runPromiseExit(...)
  |
  +--> Exit.Success(value: A) -----------------------> return value
  |
  `--> Exit.Failure(cause)
         |
         +--> Cause.failureOption(cause) = Some(e:E) -> throw e (typed error)
         |
         `--> None -------------------------------> throw cause (full chain)
```

### 3.5 Effect.exit for Result Capture

`Effect.exit` captures success/failure without throwing, useful for logging:

From `src/tools.ts` - `withToolLogging`:

```typescript
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
    const exit = yield* Effect.exit(eff); // Capture without throwing
    const durationMs = (yield* Effect.sync(() => Date.now())) - startedAt;

    if (exit._tag === "Failure") {
      const cause = exit.cause;
      yield* log.emit({ type: "tool:error", tool, durationMs, error: cause });
      return yield* Effect.failCause(cause); // Re-propagate the error
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
```

**Diagram: Exit for Logging + Re-propagation**

```text
withToolLogging(log, tool, input, eff):
  emit tool:start
  startedAt = now
  exit = Effect.exit(eff)          (does not throw)
  durationMs = now - startedAt

  if exit is Failure(cause):
    emit tool:error(durationMs, cause)
    failCause(cause)               (re-propagate failure)
  else Success(value):
    emit tool:success(durationMs, summary(value))
    succeed(value)
```

---

## 4. Async Patterns

### 4.1 Effect.tryPromise

Wraps Promise-based APIs with proper error handling:

From `src/openrouter.ts`:

```typescript
const request = (
  body: OpenRouterChatCompletionRequest,
): Effect.Effect<
  OpenRouterResponse<OpenRouterChatCompletionResponse>,
  OpenRouterError
> =>
  Effect.tryPromise({
    try: async () => {
      const resp = await withTimeout(
        url,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${cfg.grokKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        },
        TIMEOUT_MS,
      );

      const respHeaders = headersToRecord(resp.headers);
      const bodyText = await resp.text();

      if (!resp.ok) {
        throw new OpenRouterHttpError({
          status: resp.status,
          statusText: resp.statusText,
          bodyText,
        });
      }

      let parsed: unknown;
      try {
        parsed = bodyText.length === 0 ? {} : JSON.parse(bodyText);
      } catch (e) {
        throw new OpenRouterParseError({
          message: "Failed to parse JSON response",
          bodyText,
        });
      }

      return {
        body: parsed as OpenRouterChatCompletionResponse,
        headers: respHeaders,
      };
    },
    catch: (e) => {
      if (
        e instanceof OpenRouterHttpError ||
        e instanceof OpenRouterParseError ||
        e instanceof OpenRouterNetworkError
      ) {
        return e;
      }

      if (e instanceof Error && (e as any).name === "AbortError") {
        return new OpenRouterNetworkError({
          message: "Request aborted",
          cause: e,
        });
      }

      return new OpenRouterNetworkError({
        message: e instanceof Error ? e.message : "Network error",
        cause: e,
      });
    },
  });
```

From `src/tools.ts`:

```typescript
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
```

### 4.2 Retry with Schedule

Effect provides composable retry schedules. From `src/openrouter.ts`:

```typescript
const MAX_RETRIES = 3;

const isRetriableStatus = (status: number): boolean =>
  status === 408 ||
  status === 409 ||
  status === 425 ||
  status === 429 ||
  status >= 500;

const retrySchedule = Schedule.intersect(
  Schedule.exponential(Duration.millis(200)), // 200ms, 400ms, 800ms...
  Schedule.recurs(MAX_RETRIES - 1), // Max 3 retries total
).pipe(
  Schedule.whileInput((err: OpenRouterError) => {
    if (err instanceof OpenRouterNetworkError) return true; // Always retry network errors
    if (err instanceof OpenRouterParseError) return false; // Never retry parse errors
    if (err instanceof OpenRouterHttpError)
      return isRetriableStatus(err.status);
    return false;
  }),
);

// Apply retry to the request
return {
  chatCompletions: (body) => request(body).pipe(Effect.retry(retrySchedule)),
} satisfies OpenRouterClient;
```

**Diagram: Retry Decision Flow**

```text
request(body)
  |
  v
Effect.retry(retrySchedule)
  |
  +--> success -------------------------------> return response
  |
  `--> failure (OpenRouterError)
         |
         v
   whileInput(err) ?
     | true                         | false
     v                              v
  wait (exponential backoff)     propagate failure
  + limit (recurs MAX_RETRIES-1)
     |
     v
   retry request(body)
```

**Schedule combinators used:**

- `Schedule.exponential(Duration.millis(200))` - Exponential backoff starting at 200ms
- `Schedule.recurs(n)` - Limit to n retries
- `Schedule.intersect(a, b)` - Both schedules must allow retry
- `Schedule.whileInput(predicate)` - Only retry when predicate returns true

### 4.3 Timeout

The codebase uses a custom `withTimeout` wrapper for fetch, but Effect also provides:

```typescript
Effect.timeout(Duration.seconds(60));
```

**Diagram: withTimeout(fetch)**

```text
withTimeout(url, init, timeoutMs):
  upstream signal (optional) ----+
                                |
                                v
                         +--------------+
                         | AbortController
                         +--------------+
                                |
                setTimeout ---->+---- abort("timeout") if still pending
                                |
                                v
                         fetch(url, { ..., signal })
                                |
                                v
                       response or AbortError
```

### 4.4 Effect.void

For effects that produce no meaningful value:

```typescript
export const EventLogSilent = Layer.succeed(EventLog, {
  emit: () => Effect.void, // Produces void, no-op
} satisfies EventLog);
```

---

## 5. Mastra AI Integration

### 5.1 Agent Definitions

Agents use Mastra's `Agent` class. From `src/mastra.ts`:

```typescript
export const makeRepoQaAgent = (opts: {
  model: MastraLegacyLanguageModel;
  tools: ToolsInput;
}) =>
  new Agent({
    id: "repoQa",
    name: "repoQa",
    instructions:
      "You answer questions about a local directory by calling tools. Cite evidence by naming files and line numbers where possible.",
    model: opts.model,
    tools: opts.tools,
  });

export const makeDebaterAgent = (opts: {
  id: string;
  instructions: string;
  model: MastraLegacyLanguageModel;
  tools: ToolsInput;
}) =>
  new Agent({
    id: opts.id,
    name: opts.id,
    instructions: opts.instructions,
    model: opts.model,
    tools: opts.tools,
  });

export const makeJudgeAgent = (opts: { model: MastraLegacyLanguageModel }) =>
  new Agent({
    id: "judge",
    name: "judge",
    instructions:
      "You are a strict judge. You receive two candidate answers. Produce a single best answer.",
    model: opts.model,
    tools: {},
  });
```

### 5.2 Tool Definitions

Tools are represented as plain "function tool" objects (Mastra/AI-SDK compatible) but execute Effect programs internally.

This repo intentionally avoids Zod; tool inputs use JSON-Schema-like `parameters` plus lightweight runtime validation/coercion inside `execute`.

From `src/tools.ts`:

```typescript
export const makeRepoTools = (rootDir: string) =>
  Effect.gen(function* () {
    const log = yield* EventLog; // Access EventLog from context
    const rootAbs = Path.resolve(rootDir);

    const listFiles = {
      type: "function" as const,
      name: "listFiles",
      description: "List files under the target directory (safe subset).",
      parameters: {
        type: "object",
        properties: { max: { type: "integer", minimum: 1 } },
        additionalProperties: false,
      },
      execute: async (input: unknown) => {
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
          // Bridge Effect to Promise
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
    };

    // searchText + readFile follow the same pattern: JSON-schema-like parameters,
    // manual validation/coercion in execute, then run an Effect program.

    const searchText = {
      type: "function" as const,
      name: "searchText",
      description:
        "Search for a string in text files under the target directory.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", minLength: 1 },
          maxMatches: { type: "integer", minimum: 1 },
        },
        required: ["query"],
        additionalProperties: false,
      },
      execute: async (input: unknown) => {
        // Validate/coerce `input`, then:
        // return await runOrThrow(withToolLogging(log, "searchText", ..., searchTextEffect(...), ...))
      },
    };

    const readFile = {
      type: "function" as const,
      name: "readFile",
      description: "Read a UTF-8 text file under the target directory.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", minLength: 1 },
          maxBytes: { type: "integer", minimum: 1 },
        },
        required: ["path"],
        additionalProperties: false,
      },
      execute: async (input: unknown) => {
        // Validate/coerce `input`, then:
        // return await runOrThrow(withToolLogging(log, "readFile", ..., readFileEffect(...), ...))
      },
    };

    return { listFiles, searchText, readFile } as const;
  });
```

**Diagram: Repo Tool Safety Pipeline**

```text
Tool input (unknown)
  |
  v
coerce/validate (throw ToolInputError if invalid)
  |
  v
resolveInsideRoot(rootAbs, userPath)
  |
  +--> escapes root? or denied path? ----> ToolDeniedError
  |
  `--> ok
        |
        v
   safeReadTextFile / walkFiles
        |
        v
   output (possibly truncated) + EventLog events
```

### 5.3 Model Adapter

`makeOpenRouterLanguageModelV1` is an Effect program that returns a Mastra-compatible `LanguageModelV1`:

```typescript
export const makeOpenRouterLanguageModelV1 = Effect.gen(function* () {
  const cfg = yield* AppConfig;
  const client = yield* OpenRouterClient;

  const doGenerate: LanguageModelV1["doGenerate"] = async (options) => {
    const messages = promptToOpenAiMessages(options.prompt);
    const requestBody: OpenRouterChatCompletionRequest = {
      model: cfg.grokModel,
      messages,
      stream: false,
      // ... other options
    };

    const { body: resp, headers } = await runOrThrow(
      client.chatCompletions(requestBody),
    );
    // ... process response
    return { finishReason, usage, text, toolCalls /* ... */ };
  };

  const model: MastraLegacyLanguageModel = {
    specificationVersion: "v1",
    provider: "openrouter",
    modelId: cfg.grokModel,
    doGenerate,
    doStream,
  };

  return model;
});
```

### 5.4 Composing the Application

The entry point composes all layers and runs the Effect program:

```typescript
const LiveLayers = Layer.mergeAll(
  Layer.provideMerge(ConfigLayer)(ClientLayer),
  EventLogLive,
);

const agents = await Effect.runPromise(
  Effect.gen(function* () {
    const cfg = yield* AppConfig;
    const tools = yield* makeRepoTools(cfg.demoTargetDir);
    const model = yield* makeOpenRouterLanguageModelV1;

    return {
      repoQa: makeRepoQaAgent({ model, tools }),
      debaterA: makeDebaterAgent({
        id: "debaterA",
        instructions: "...",
        model,
        tools,
      }),
      debaterB: makeDebaterAgent({
        id: "debaterB",
        instructions: "...",
        model,
        tools,
      }),
      judge: makeJudgeAgent({ model }),
    } as const;
  }).pipe(Effect.provide(LiveLayers)),
);

export const mastra = new Mastra({ agents, logger });
```

**Diagram: Tool Loop (Agent <-> Model <-> Tools)**

```text
User -> Mastra -> ModelAdapter -> OpenRouterClient (Effect: retry + timeout) -> fetch()
fetch() -> OpenRouterClient -> ModelAdapter -> Mastra -> User

If the model returns tool_calls:
  ModelAdapter -> Mastra: tool_calls
  Mastra -> Repo Tools: execute(args)
  Repo Tools -> Local FS: list/search/read (safe subset)
  Local FS -> Repo Tools -> Mastra: tool_result
  Mastra -> ModelAdapter: prompt + tool_result
  ...repeat until the model returns final text...
```

---

## 6. Testing with Effect

### 6.1 Layer-based Test Doubles

Effect's Layer system makes it easy to replace services with test implementations:

From `test/openrouter.test.ts`:

```typescript
const TestConfigLive = (overrides: Partial<AppConfigType> = {}) =>
  Layer.succeed(AppConfig, {
    grokKey: "test-key",
    grokModel: "test-model",
    baseUrl: "https://openrouter.ai/api/v1",
    logLevel: "info",
    demoTargetDir: ".",
    demoQuestion: undefined,
    ...overrides,
  } satisfies AppConfigType);
```

From `test/integration_fake_llm.test.ts` — note `OpenRouterClient.make(...)` and `EventLog.make(...)` for test doubles:

```typescript
const LiveLayers = [
  Layer.succeed(AppConfig, cfg),
  Layer.succeed(OpenRouterClient, fakeClient),
  Layer.succeed(
    EventLog,
    EventLog.make({
      emit: (event) => Effect.sync(() => void events.push(event)),
    }),
  ),
] as const;
```

### 6.2 Fake LLM Implementation

Create deterministic fake clients using `Effect.sync` and `OpenRouterClient.make(...)`:

```typescript
let calls = 0;
const fakeClient = OpenRouterClient.make({
  chatCompletions: (body: OpenRouterChatCompletionRequest) =>
    Effect.sync(() => {
      calls++;
      if (calls === 1) {
        // First call: return a tool call
        return {
          body: {
            id: "1",
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      id: "tc1",
                      type: "function",
                      function: {
                        name: "listFiles",
                        arguments: JSON.stringify({ max: 5 }),
                      },
                    },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          },
          headers: {},
        };
      }

      // Second call: return final answer
      return {
        body: {
          id: "2",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "Done." },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        },
        headers: {},
      };
    }),
});
```

### 6.3 Error Testing with Exit

Test error conditions using `Effect.runPromiseExit`:

From `test/config.test.ts`:

```typescript
it("fails fast when GROK_KEY is missing", async () => {
  await withEnv(
    {
      GROK_KEY: undefined,
      GROK_MODEL: "openrouter/example-model",
    },
    async () => {
      const exit = await Effect.runPromiseExit(readAppConfig);
      expect(exit._tag).toBe("Failure");
      if (exit._tag !== "Failure") return;

      const err = Cause.failureOption(exit.cause);
      expect(Option.isSome(err)).toBe(true);
      if (!Option.isSome(err)) return;

      expect(err.value).toMatchObject({ _tag: "ConfigError", key: "GROK_KEY" });
    },
  );
});
```

From `test/openrouter.test.ts`:

```typescript
it("maps non-2xx to OpenRouterHttpError", async () => {
  const fetchMock = vi.fn(async () => new Response("nope", { status: 400 }));
  globalThis.fetch = fetchMock;

  const program = Effect.gen(function* () {
    const client = yield* OpenRouterClient;
    return yield* client.chatCompletions(body);
  });

  const exit = await Effect.runPromiseExit(
    program.pipe(
      Effect.provide([
        Layer.provideMerge(TestConfigLive())(OpenRouterClientLive),
      ]),
    ),
  );

  expect(exit._tag).toBe("Failure");
  if (exit._tag !== "Failure") return;

  const err = Cause.failureOption(exit.cause);
  expect(Option.isSome(err)).toBe(true);
  if (!Option.isSome(err)) return;

  expect(err.value).toBeInstanceOf(OpenRouterHttpError);
});
```

### 6.4 Testing Retry Behavior

From `test/openrouter.test.ts`:

```typescript
it("retries on 429", async () => {
  let calls = 0;
  const fetchMock = vi.fn(async () => {
    calls++;
    if (calls === 1) {
      return new Response("rate limited", { status: 429 });
    }
    return new Response(
      JSON.stringify({
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "ok" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
      { status: 200 },
    );
  });
  globalThis.fetch = fetchMock;

  await Effect.runPromise(
    program.pipe(
      Effect.provide([
        Layer.provideMerge(TestConfigLive())(OpenRouterClientLive),
      ]),
    ),
  );

  expect(fetchMock).toHaveBeenCalledTimes(2); // Retried once
});
```

### 6.5 Full Integration Test

From `test/integration_fake_llm.test.ts`:

```typescript
it("executes one tool call then finishes", async () => {
  const dir = await makeTempDir();
  await Fs.writeFile(Path.join(dir, "a.txt"), "hello\n", "utf8");

  const events: ToolEvent[] = [];
  const fakeClient = /* ... */;
  const cfg = /* ... */;

  const LiveLayers = [
    Layer.succeed(AppConfig, cfg),
    Layer.succeed(OpenRouterClient, fakeClient),
    Layer.succeed(
      EventLog,
      EventLog.make({
        emit: (event) => Effect.sync(() => void events.push(event)),
      }),
    ),
  ] as const;

  const agent = await Effect.runPromise(
    Effect.gen(function* () {
      const tools = yield* makeRepoTools(dir);
      const model = yield* makeOpenRouterLanguageModelV1;
      return makeRepoQaAgent({ model, tools });
    }).pipe(Effect.provide(LiveLayers)),
  );

  const out = await agent.generateLegacy("List files then say Done.");

  expect(out.text).toContain("Done.");
  expect(events.some((e) => e.type === "tool:start" && e.tool === "listFiles")).toBe(true);
  expect(events.some((e) => e.type === "tool:success" && e.tool === "listFiles")).toBe(true);
});
```

---

## Summary

This codebase demonstrates a comprehensive integration of Effect-TS with Mastra AI:

1. **Core Effect patterns**: `Effect.gen`, `Effect.fn`, `Effect.pipe`, and constructors for building composable programs
2. **Dependency injection**: `Effect.Service` (behavioral services) and `Context.GenericTag` (config data), composed via Layers
3. **Typed errors**: `Data.TaggedError` for discriminated union error types
4. **Async patterns**: `Effect.tryPromise`, retry schedules, and timeouts
5. **Bridge pattern**: `runOrThrow` for integrating with Promise-based APIs
6. **Observability**: `Effect.fn` for automatic tracing spans, `Effect.log` for structured logging
7. **Testing**: Layer-based test doubles via `Service.make(...)` and `Effect.runPromiseExit` for error assertions

The architecture achieves type safety, testability, and composability while integrating with Mastra's Promise-based agent framework.
