import { Data, Effect, Layer } from "effect";
import { AppConfig } from "./config.js";
import {
  fetchWithTimeout,
  headersToRecord,
  retrySchedule,
  HttpError,
  NetworkError,
  ParseError,
} from "./http-effect.js";

// Re-export error types under their original names for backward compat
export {
  HttpError as OpenRouterHttpError,
  NetworkError as OpenRouterNetworkError,
  ParseError as OpenRouterParseError,
};

export type OpenRouterError = NetworkError | HttpError | ParseError;

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

export type OpenRouterResponse<A> = {
  body: A;
  headers: Record<string, string>;
};

const isRetriableStatus = (status: number): boolean =>
  status === 408 ||
  status === 409 ||
  status === 425 ||
  status === 429 ||
  status >= 500;

const MAX_RETRIES = 3;
const TIMEOUT_MS = 60_000;

const buildOpenRouterClient = Effect.gen(function* () {
  const cfg = yield* AppConfig;
  const url = `${cfg.baseUrl}/chat/completions`;

  const request = (
    body: OpenRouterChatCompletionRequest,
  ): Effect.Effect<
    OpenRouterResponse<OpenRouterChatCompletionResponse>,
    OpenRouterError
  > =>
    Effect.tryPromise({
      try: async () => {
        const resp = await fetchWithTimeout(
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
          throw new HttpError({
            status: resp.status,
            statusText: resp.statusText,
            bodyText,
          });
        }

        let parsed: unknown;
        try {
          parsed = bodyText.length === 0 ? {} : JSON.parse(bodyText);
        } catch {
          throw new ParseError({
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
          e instanceof HttpError ||
          e instanceof ParseError ||
          e instanceof NetworkError
        )
          return e;
        if (e instanceof Error && (e as any).name === "AbortError")
          return new NetworkError({ message: "Request aborted", cause: e });
        return new NetworkError({
          message: e instanceof Error ? e.message : "Network error",
          cause: e,
        });
      },
    });

  const schedule = retrySchedule<OpenRouterError>({
    baseMs: 200,
    maxRetries: MAX_RETRIES,
    shouldRetry: (err) => {
      if (err instanceof NetworkError) return true;
      if (err instanceof ParseError) return false;
      if (err instanceof HttpError) return isRetriableStatus(err.status);
      return false;
    },
  });

  return {
    chatCompletions: (body: OpenRouterChatCompletionRequest) =>
      request(body).pipe(Effect.retry(schedule)),
  };
});

export class OpenRouterClient extends Effect.Service<OpenRouterClient>()(
  "OpenRouterClient",
  {
    effect: buildOpenRouterClient,
  },
) {}

export const OpenRouterClientLive = OpenRouterClient.Default;
