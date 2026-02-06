import { afterEach, describe, expect, it } from "@rstest/core";
import { Cause, Effect, Layer, Option } from "effect";
import { AppConfig, type AppConfig as AppConfigType } from "../src/config.js";
import {
  OpenRouterClient,
  OpenRouterClientLive,
  OpenRouterHttpError,
  type OpenRouterChatCompletionRequest,
} from "../src/openrouter.js";

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

describe("openrouter client", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("sends Authorization header and model", async () => {
    let calls = 0;
    const fetchMock = async (_input: any, init: any) => {
      calls++;
      const body = JSON.parse(init.body);
      expect(init.headers.authorization).toBe("Bearer test-key");
      expect(body.model).toBe("my-model");
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
    };
    globalThis.fetch = fetchMock as any;

    const body: OpenRouterChatCompletionRequest = {
      model: "my-model",
      messages: [{ role: "user", content: "hi" }],
      stream: false,
    };

    const program = Effect.gen(function* () {
      const client = yield* OpenRouterClient;
      return yield* client.chatCompletions(body);
    });

    const Live = Layer.provideMerge(TestConfigLive())(OpenRouterClientLive);
    await Effect.runPromise(program.pipe(Effect.provide([Live] as const)));
    expect(calls).toBe(1);
  });

  it("maps non-2xx to OpenRouterHttpError", async () => {
    let calls = 0;
    const fetchMock = async () => {
      calls++;
      return new Response("nope", { status: 400, statusText: "Bad Request" });
    };
    globalThis.fetch = fetchMock as any;

    const body: OpenRouterChatCompletionRequest = {
      model: "my-model",
      messages: [{ role: "user", content: "hi" }],
      stream: false,
    };

    const program = Effect.gen(function* () {
      const client = yield* OpenRouterClient;
      return yield* client.chatCompletions(body);
    });

    const exit = await Effect.runPromiseExit(
      program.pipe(
        Effect.provide([
          Layer.provideMerge(TestConfigLive())(OpenRouterClientLive),
        ] as const),
      ),
    );
    expect(exit._tag).toBe("Failure");
    if (exit._tag !== "Failure") return;
    const err = Cause.failureOption(exit.cause);
    expect(Option.isSome(err)).toBe(true);
    if (!Option.isSome(err)) return;
    expect(err.value).toBeInstanceOf(OpenRouterHttpError);
    expect(calls).toBe(1);
  });

  it("retries on 429", async () => {
    let calls = 0;
    const fetchMock = async () => {
      calls++;
      if (calls === 1) {
        return new Response("rate limited", {
          status: 429,
          statusText: "Too Many Requests",
        });
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
    };
    globalThis.fetch = fetchMock as any;

    const body: OpenRouterChatCompletionRequest = {
      model: "my-model",
      messages: [{ role: "user", content: "hi" }],
      stream: false,
    };

    const program = Effect.gen(function* () {
      const client = yield* OpenRouterClient;
      return yield* client.chatCompletions(body);
    });

    await Effect.runPromise(
      program.pipe(
        Effect.provide([
          Layer.provideMerge(TestConfigLive())(OpenRouterClientLive),
        ] as const),
      ),
    );
    expect(calls).toBe(2);
  });
});
