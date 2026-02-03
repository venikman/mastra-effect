# Effect-TS Technical Report

This report documents how Effect-TS is used in the mastra-effect project, covering core concepts, dependency injection, error handling, async patterns, Mastra AI integration, and testing strategies.

---

## 1. Effect-TS Core Concepts

### 1.1 The Effect Type

`Effect<A, E, R>` is the central type representing a computation that:
- **A** - Succeeds with a value of type A
- **E** - May fail with an error of type E  
- **R** - Requires an environment/context of type R

Key imports used throughout this codebase:

```typescript
import { Effect, Context, Layer, Data, Cause, Option, Schedule, Duration } from "effect";
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
  const cfg = yield* AppConfig;           // Access AppConfig service from context
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
  Effect.timeout(Duration.seconds(60))
)
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
Effect.sync(() => process.env[key])
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
})
```

**Effect.flatMap** - Sequential composition:
```typescript
const readRequiredEnv = (key: string) =>
  Effect.sync(() => process.env[key]).pipe(
    Effect.flatMap((value) => {
      const trimmed = value?.trim() ?? "";
      if (trimmed.length === 0) {
        return Effect.fail(new ConfigError({ key, message: `Missing required env var ${key}` }));
      }
      return Effect.succeed(trimmed);
    }),
  );
```

---

## 2. Dependency Injection (Context + Layer)

### 2.1 Service Definition Pattern

Effect-TS uses a three-part pattern for defining services:

**Step 1: Define the service interface type**

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
```

**Step 2: Create a Context tag**

```typescript
export const AppConfig = Context.GenericTag<AppConfig>("AppConfig");
```

The tag serves as both a type-level identifier and a runtime key for the service.

**Step 3: Create a Layer implementation**

```typescript
export const AppConfigLive = Layer.effect(AppConfig, readAppConfig);
```

### 2.2 Services in This Codebase

| Service | File | Tag Definition | Layer Type |
|---------|------|----------------|------------|
| `AppConfig` | `src/config.ts:19` | `Context.GenericTag<AppConfig>("AppConfig")` | `Layer.effect` (async) |
| `OpenRouterClient` | `src/openrouter.ts:104` | `Context.GenericTag<OpenRouterClient>("OpenRouterClient")` | `Layer.effect` (async) |
| `EventLog` | `src/tools.ts:31` | `Context.GenericTag<EventLog>("EventLog")` | `Layer.succeed` (sync) |

### 2.3 OpenRouterClient Service

From `src/openrouter.ts`:

```typescript
// Service interface
export type OpenRouterClient = {
  chatCompletions: (
    body: OpenRouterChatCompletionRequest,
  ) => Effect.Effect<OpenRouterResponse<OpenRouterChatCompletionResponse>, OpenRouterError>;
};

// Context tag
export const OpenRouterClient = Context.GenericTag<OpenRouterClient>("OpenRouterClient");

// Layer implementation (depends on AppConfig)
export const OpenRouterClientLive = Layer.effect(
  OpenRouterClient,
  Effect.gen(function* () {
    const cfg = yield* AppConfig;  // Access dependency
    const url = `${cfg.baseUrl}/chat/completions`;

    const request = (body: OpenRouterChatCompletionRequest) =>
      Effect.tryPromise({ /* ... */ });

    const retrySchedule = Schedule.intersect(/* ... */);

    return {
      chatCompletions: (body) => request(body).pipe(Effect.retry(retrySchedule)),
    } satisfies OpenRouterClient;
  }),
);
```

### 2.4 EventLog Service

From `src/tools.ts`:

```typescript
// Service interface
export type EventLog = {
  emit: (event: ToolEvent) => Effect.Effect<void>;
};

// Context tag
export const EventLog = Context.GenericTag<EventLog>("EventLog");

// Live layer with JSONL logging
export const EventLogLive = Layer.succeed(EventLog, {
  emit: (event) =>
    Effect.sync(() => {
      console.log(JSON.stringify({ ts: new Date().toISOString(), ...event }));
    }),
} satisfies EventLog);

// Silent layer for testing
export const EventLogSilent = Layer.succeed(EventLog, {
  emit: () => Effect.void,
} satisfies EventLog);
```

### 2.5 Accessing Services

Inside `Effect.gen`, use `yield*` with the Context tag:

```typescript
Effect.gen(function* () {
  const cfg = yield* AppConfig;           // Type: AppConfig
  const client = yield* OpenRouterClient; // Type: OpenRouterClient
  const log = yield* EventLog;            // Type: EventLog
});
```

### 2.6 Providing Layers

**Single layer:**
```typescript
program.pipe(Effect.provide(AppConfigLive))
```

**Multiple layers with dependencies:**

From `.mastra/.build/entry-0.mjs`:
```typescript
const Live = Layer.mergeAll(
  EventLogLive,
  Layer.provideMerge(AppConfigLive)(OpenRouterClientLive)
);
program.pipe(Effect.provide(Live))
```

The `Layer.provideMerge(AppConfigLive)(OpenRouterClientLive)` pattern provides `AppConfig` to `OpenRouterClientLive` since the OpenRouter client depends on configuration.

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
export class OpenRouterNetworkError extends Data.TaggedError("OpenRouterNetworkError")<{
  message: string;
  cause?: unknown;
}> {}

export class OpenRouterHttpError extends Data.TaggedError("OpenRouterHttpError")<{
  status: number;
  statusText: string;
  bodyText: string;
}> {}

export class OpenRouterParseError extends Data.TaggedError("OpenRouterParseError")<{
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
Effect.fail(new ConfigError({ key: "GROK_KEY", message: "Missing" }))
```

**In tryPromise catch handler:**
```typescript
Effect.tryPromise({
  try: () => fetch(url),
  catch: (e) => {
    if (e instanceof OpenRouterHttpError) return e;
    return new OpenRouterNetworkError({ message: String(e), cause: e });
  }
})
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
  return exit.value;  // Type: A
}

if (exit._tag === "Failure") {
  // exit.cause contains the full error chain
  const err = Cause.failureOption(exit.cause);
  if (Option.isSome(err)) {
    // err.value is the typed error (ConfigError | OpenRouterHttpError | ...)
    console.log(err.value._tag);  // "ConfigError", "OpenRouterHttpError", etc.
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
      throw err.value;  // Throw the typed error
    }
    throw exit.cause;   // Throw the full cause if no simple failure
  }
  return exit.value;
};
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
    const exit = yield* Effect.exit(eff);  // Capture without throwing
    const durationMs = (yield* Effect.sync(() => Date.now())) - startedAt;

    if (exit._tag === "Failure") {
      const cause = exit.cause;
      yield* log.emit({ type: "tool:error", tool, durationMs, error: cause });
      return yield* Effect.failCause(cause);  // Re-propagate the error
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

---

## 4. Async Patterns

### 4.1 Effect.tryPromise

Wraps Promise-based APIs with proper error handling:

From `src/openrouter.ts`:
```typescript
const request = (
  body: OpenRouterChatCompletionRequest,
): Effect.Effect<OpenRouterResponse<OpenRouterChatCompletionResponse>, OpenRouterError> =>
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
        return new OpenRouterNetworkError({ message: "Request aborted", cause: e });
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
  status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;

const retrySchedule = Schedule.intersect(
  Schedule.exponential(Duration.millis(200)),  // 200ms, 400ms, 800ms...
  Schedule.recurs(MAX_RETRIES - 1),            // Max 3 retries total
).pipe(
  Schedule.whileInput((err: OpenRouterError) => {
    if (err instanceof OpenRouterNetworkError) return true;  // Always retry network errors
    if (err instanceof OpenRouterParseError) return false;   // Never retry parse errors
    if (err instanceof OpenRouterHttpError) return isRetriableStatus(err.status);
    return false;
  }),
);

// Apply retry to the request
return {
  chatCompletions: (body) => request(body).pipe(Effect.retry(retrySchedule)),
} satisfies OpenRouterClient;
```

**Schedule combinators used:**
- `Schedule.exponential(Duration.millis(200))` - Exponential backoff starting at 200ms
- `Schedule.recurs(n)` - Limit to n retries
- `Schedule.intersect(a, b)` - Both schedules must allow retry
- `Schedule.whileInput(predicate)` - Only retry when predicate returns true

### 4.3 Timeout

The codebase uses a custom `withTimeout` wrapper for fetch, but Effect also provides:

```typescript
Effect.timeout(Duration.seconds(60))
```

### 4.4 Effect.void

For effects that produce no meaningful value:

```typescript
export const EventLogSilent = Layer.succeed(EventLog, {
  emit: () => Effect.void,  // Produces void, no-op
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
    id: "repo-qa",
    name: "repo-qa",
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

Tools use `createTool` from `@mastra/core/tools` but execute Effect programs internally:

From `src/tools.ts`:
```typescript
export const makeRepoTools = (rootDir: string) =>
  Effect.gen(function* () {
    const log = yield* EventLog;  // Access EventLog from context
    const rootAbs = Path.resolve(rootDir);

    const listFiles = createTool({
      id: "listFiles",
      description: "List files under the target directory (safe subset).",
      inputSchema: z.object({ max: z.number().int().positive().optional() }).optional(),
      execute: async (input) => {
        const maxFiles = input?.max ?? DEFAULT_MAX_FILES;
        return await runOrThrow(  // Bridge Effect to Promise
          withToolLogging(
            log,
            "listFiles",
            { max: maxFiles },
            listFilesEffect(rootAbs, maxFiles),
            (out) => ({ fileCount: out.files.length, sample: out.files.slice(0, 20) }),
          ),
        );
      },
    });

    const searchText = createTool({
      id: "searchText",
      description: "Search for a string in text files under the target directory.",
      inputSchema: z.object({
        query: z.string().min(1),
        maxMatches: z.number().int().positive().optional(),
      }),
      execute: async (input) => {
        const maxMatches = input.maxMatches ?? DEFAULT_MAX_MATCHES;
        return await runOrThrow(
          withToolLogging(
            log,
            "searchText",
            { query: input.query, maxMatches },
            searchTextEffect(rootAbs, input.query, maxMatches),
            (out) => ({ matchCount: out.matches.length }),
          ),
        );
      },
    });

    const readFile = createTool({
      id: "readFile",
      description: "Read a UTF-8 text file under the target directory.",
      inputSchema: z.object({
        path: z.string().min(1),
        maxBytes: z.number().int().positive().optional(),
      }),
      execute: async (input) => {
        const maxBytes = input.maxBytes ?? DEFAULT_MAX_FILE_BYTES;
        return await runOrThrow(
          withToolLogging(
            log,
            "readFile",
            { path: input.path, maxBytes },
            readFileEffect(rootAbs, input.path, maxBytes),
            (out) => ({ path: out.path, bytes: out.content.length, truncated: out.truncated }),
          ),
        );
      },
    });

    return { listFiles, searchText, readFile } as const;
  });
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

    const { body: resp, headers } = await runOrThrow(client.chatCompletions(requestBody));
    // ... process response
    return { finishReason, usage, text, toolCalls, /* ... */ };
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
const Live = Layer.mergeAll(
  EventLogLive,
  Layer.provideMerge(AppConfigLive)(OpenRouterClientLive)
);

const program = Effect.gen(function* () {
  const cfg = yield* AppConfig;
  const tools = yield* makeRepoTools(cfg.demoTargetDir);
  const model = yield* makeOpenRouterLanguageModelV1;
  return makeRepoQaAgent({ model, tools });
});

const agent = await Effect.runPromise(program.pipe(Effect.provide(Live)));
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

From `test/integration_fake_llm.test.ts`:
```typescript
const LiveLayers = [
  Layer.succeed(AppConfig, cfg),
  Layer.succeed(OpenRouterClient, fakeClient),
  Layer.succeed(EventLog, {
    emit: (event) => Effect.sync(() => void events.push(event)),
  }),
] as const;
```

### 6.2 Fake LLM Implementation

Create deterministic fake clients using `Effect.sync`:

```typescript
let calls = 0;
const fakeClient: OpenRouterClientType = {
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
                      function: { name: "listFiles", arguments: JSON.stringify({ max: 5 }) },
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
};
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
    program.pipe(Effect.provide([Layer.provideMerge(TestConfigLive())(OpenRouterClientLive)])),
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
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
      { status: 200 },
    );
  });
  globalThis.fetch = fetchMock;

  await Effect.runPromise(
    program.pipe(Effect.provide([Layer.provideMerge(TestConfigLive())(OpenRouterClientLive)])),
  );
  
  expect(fetchMock).toHaveBeenCalledTimes(2);  // Retried once
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
    Layer.succeed(EventLog, {
      emit: (event) => Effect.sync(() => void events.push(event)),
    }),
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

1. **Core Effect patterns**: `Effect.gen`, `Effect.pipe`, and constructors for building composable programs
2. **Dependency injection**: Context tags and Layers for clean service separation
3. **Typed errors**: `Data.TaggedError` for discriminated union error types
4. **Async patterns**: `Effect.tryPromise`, retry schedules, and timeouts
5. **Bridge pattern**: `runOrThrow` for integrating with Promise-based APIs
6. **Testing**: Layer-based test doubles and `Effect.runPromiseExit` for error assertions

The architecture achieves type safety, testability, and composability while integrating with Mastra's Promise-based agent framework.
