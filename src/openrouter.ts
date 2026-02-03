import { Context, Data, Duration, Effect, Layer, Schedule } from "effect";
import { AppConfig } from "./config.js";

export type OpenAIChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }>;
    }
  | { role: "tool"; tool_call_id: string; content: string };

export type OpenAIChatTool = {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: unknown;
  };
};

export type OpenAIChatToolChoice =
  | "auto"
  | "none"
  | "required"
  | { type: "function"; function: { name: string } };

export type OpenRouterChatCompletionRequest = {
  model: string;
  messages: OpenAIChatMessage[];
  tools?: OpenAIChatTool[];
  tool_choice?: OpenAIChatToolChoice;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stop?: string[];
  presence_penalty?: number;
  frequency_penalty?: number;
  seed?: number;
  stream?: false;
};

export type OpenRouterChatCompletionResponse = {
  id?: string;
  choices: Array<{
    index: number;
    message: {
      role: "assistant";
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }>;
    };
    finish_reason: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
};

export class OpenRouterNetworkError extends Data.TaggedError(
  "OpenRouterNetworkError",
)<{
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

export type OpenRouterError =
  | OpenRouterNetworkError
  | OpenRouterHttpError
  | OpenRouterParseError;

export type OpenRouterResponse<A> = {
  body: A;
  headers: Record<string, string>;
};

export type OpenRouterClient = {
  chatCompletions: (
    body: OpenRouterChatCompletionRequest,
  ) => Effect.Effect<OpenRouterResponse<OpenRouterChatCompletionResponse>, OpenRouterError>;
};

export const OpenRouterClient = Context.GenericTag<OpenRouterClient>("OpenRouterClient");

const isRetriableStatus = (status: number): boolean =>
  status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;

const withTimeout = async (
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> => {
  const controller = new AbortController();
  const existingSignal = init.signal;

  const abortFromUpstream = () => controller.abort(existingSignal?.reason);
  if (existingSignal) {
    if (existingSignal.aborted) {
      abortFromUpstream();
    } else {
      existingSignal.addEventListener("abort", abortFromUpstream, { once: true });
    }
  }

  const timeoutId = setTimeout(() => controller.abort("timeout"), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
    if (existingSignal) {
      existingSignal.removeEventListener("abort", abortFromUpstream);
    }
  }
};

const headersToRecord = (headers: Headers): Record<string, string> => {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
};

const MAX_RETRIES = 3;
const TIMEOUT_MS = 60_000;

export const OpenRouterClientLive = Layer.effect(
  OpenRouterClient,
  Effect.gen(function* () {
    const cfg = yield* AppConfig;
    const url = `${cfg.baseUrl}/chat/completions`;

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

          if (e instanceof OpenRouterHttpError) {
            return e;
          }

          if (e instanceof Error && (e as any).name === "AbortError") {
            return new OpenRouterNetworkError({ message: "Request aborted", cause: e });
          }

          if (e instanceof OpenRouterHttpError) return e;
          return new OpenRouterNetworkError({
            message: e instanceof Error ? e.message : "Network error",
            cause: e,
          });
        },
      });

    const retrySchedule = Schedule.intersect(
      Schedule.exponential(Duration.millis(200)),
      Schedule.recurs(MAX_RETRIES - 1),
    ).pipe(
      Schedule.whileInput((err: OpenRouterError) => {
        if (err instanceof OpenRouterNetworkError) return true;
        if (err instanceof OpenRouterParseError) return false;
        if (err instanceof OpenRouterHttpError) return isRetriableStatus(err.status);
        return false;
      }),
    );

    return {
      chatCompletions: (body) => request(body).pipe(Effect.retry(retrySchedule)),
    } satisfies OpenRouterClient;
  }),
);

