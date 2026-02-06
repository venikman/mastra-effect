import { ReadableStream } from "node:stream/web";
import { Agent } from "@mastra/core/agent";
import type { ToolsInput, MastraLegacyLanguageModel } from "@mastra/core/agent";
import type {
  LanguageModelV1,
  LanguageModelV1CallOptions,
  LanguageModelV1StreamPart,
} from "@mastra/core/_types/@internal_ai-sdk-v4/dist";
import { Cause, Data, Effect, Option, Schema } from "effect";
import { AppConfig } from "./config.js";
import {
  OpenRouterClient,
  type OpenAIChatMessage,
  type OpenAIChatTool,
  type OpenAIChatToolChoice,
  type OpenRouterChatCompletionRequest,
  type OpenRouterChatCompletionResponse,
} from "./openrouter.js";

export class ModelAdapterError extends Data.TaggedError("ModelAdapterError")<{
  message: string;
  cause?: unknown;
}> {}

const runOrThrow = async <A, E>(eff: Effect.Effect<A, E>): Promise<A> => {
  const exit = await Effect.runPromiseExit(eff);
  if (exit._tag === "Failure") {
    const err = Cause.failureOption(exit.cause);
    if (Option.isSome(err)) throw err.value;
    throw exit.cause;
  }
  return exit.value;
};

// ─── Schema-based type guards (replaces hand-rolled isTextPart / isToolCallPart) ─

const TextPart = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String,
});
const isTextPart = Schema.is(TextPart);

const ToolCallPart = Schema.Struct({
  type: Schema.Literal("tool-call"),
  toolCallId: Schema.String,
  toolName: Schema.String,
  args: Schema.Unknown,
});
const isToolCallPart = Schema.is(ToolCallPart);

// ─── Prompt / tool conversion ────────────────────────────────────────────────

const promptToOpenAiMessages = (
  prompt: LanguageModelV1CallOptions["prompt"],
): OpenAIChatMessage[] => {
  const out: OpenAIChatMessage[] = [];

  for (const msg of prompt) {
    if (msg.role === "system" || msg.role === "user") {
      const parts =
        typeof msg.content === "string"
          ? [{ type: "text" as const, text: msg.content }]
          : msg.content;
      const content = parts
        .filter(isTextPart)
        .map((p) => p.text)
        .join("");
      out.push({ role: msg.role, content });
      continue;
    }

    if (msg.role === "assistant") {
      const parts =
        typeof msg.content === "string"
          ? [{ type: "text" as const, text: msg.content }]
          : msg.content;
      const content = parts
        .filter(isTextPart)
        .map((p) => p.text)
        .join("");

      const toolCalls = parts.filter(isToolCallPart).map((p) => ({
        id: p.toolCallId,
        type: "function" as const,
        function: {
          name: p.toolName,
          arguments: JSON.stringify(p.args ?? {}),
        },
      }));

      out.push({
        role: "assistant",
        content: content.length > 0 ? content : null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
      continue;
    }

    if (msg.role === "tool") {
      for (const part of msg.content) {
        if (part.type !== "tool-result") continue;
        out.push({
          role: "tool",
          tool_call_id: part.toolCallId,
          content: JSON.stringify(part.result ?? null),
        });
      }
      continue;
    }
  }

  return out;
};

const toolsToOpenAiTools = (tools: unknown): OpenAIChatTool[] => {
  if (!Array.isArray(tools)) return [];
  return tools
    .filter((t: any) => t?.type === "function")
    .map(
      (t: any): OpenAIChatTool => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }),
    );
};

const toolChoiceToOpenAiToolChoice = (
  choice: any,
): OpenAIChatToolChoice | undefined => {
  if (!choice) return undefined;
  switch (choice.type) {
    case "auto":
      return "auto";
    case "none":
      return "none";
    case "required":
      return "required";
    case "tool":
      return { type: "function", function: { name: choice.toolName } };
    default:
      return undefined;
  }
};

type FinishReason =
  | "stop"
  | "length"
  | "tool-calls"
  | "content-filter"
  | "error"
  | "other"
  | "unknown";

const mapFinishReason = (finish: string | null | undefined): FinishReason => {
  switch (finish) {
    case "stop":
      return "stop";
    case "length":
      return "length";
    case "tool_calls":
      return "tool-calls";
    default:
      return "other";
  }
};

const getFirstChoice = (resp: OpenRouterChatCompletionResponse) => {
  const choice = resp.choices?.[0];
  if (!choice) {
    throw new ModelAdapterError({
      message: "OpenRouter response has no choices",
    });
  }
  return choice;
};

// ─── Language model adapter ──────────────────────────────────────────────────

export const makeOpenRouterLanguageModelV1 = Effect.gen(function* () {
  const cfg = yield* AppConfig;
  const client = yield* OpenRouterClient;

  const doGenerate: LanguageModelV1["doGenerate"] = async (
    options: LanguageModelV1CallOptions,
  ) => {
    const messages = promptToOpenAiMessages(options.prompt);

    const requestBody: OpenRouterChatCompletionRequest = {
      model: cfg.grokModel,
      messages,
      stream: false,
      ...(typeof options.maxTokens === "number"
        ? { max_tokens: options.maxTokens }
        : {}),
      ...(typeof options.temperature === "number"
        ? { temperature: options.temperature }
        : {}),
      ...(typeof options.topP === "number" ? { top_p: options.topP } : {}),
      ...(typeof options.presencePenalty === "number"
        ? { presence_penalty: options.presencePenalty }
        : {}),
      ...(typeof options.frequencyPenalty === "number"
        ? { frequency_penalty: options.frequencyPenalty }
        : {}),
      ...(Array.isArray(options.stopSequences) &&
      options.stopSequences.length > 0
        ? { stop: options.stopSequences }
        : {}),
      ...(typeof options.seed === "number" ? { seed: options.seed } : {}),
    };

    if (options.mode.type === "regular") {
      const tools = toolsToOpenAiTools(options.mode.tools);
      if (tools.length > 0) requestBody.tools = tools;
      const toolChoice = toolChoiceToOpenAiToolChoice(options.mode.toolChoice);
      if (toolChoice) requestBody.tool_choice = toolChoice;
    }

    const { body: resp, headers } = await runOrThrow(
      client.chatCompletions(requestBody),
    );
    const choice = getFirstChoice(resp);

    const toolCalls =
      choice.message.tool_calls?.map((call) => ({
        toolCallType: "function" as const,
        toolCallId: call.id,
        toolName: call.function.name,
        args: call.function.arguments,
      })) ?? [];

    const finishReason = mapFinishReason(choice.finish_reason);

    return {
      finishReason,
      usage: {
        promptTokens: resp.usage?.prompt_tokens ?? 0,
        completionTokens: resp.usage?.completion_tokens ?? 0,
      },
      rawCall: {
        rawPrompt: requestBody,
        rawSettings: {
          model: cfg.grokModel,
          ...(typeof options.maxTokens === "number"
            ? { maxTokens: options.maxTokens }
            : {}),
        },
      },
      rawResponse: { headers, body: resp },
      request: { body: JSON.stringify(requestBody) },
      response: {
        modelId: cfg.grokModel,
        ...(resp.id ? { id: resp.id } : {}),
      },
      ...(choice.message.content !== null
        ? { text: choice.message.content }
        : {}),
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
    };
  };

  const doStream: LanguageModelV1["doStream"] = async (
    options: LanguageModelV1CallOptions,
  ) => {
    const startedAt = Date.now();
    try {
      const generated = await doGenerate(options);

      const stream = new ReadableStream<LanguageModelV1StreamPart>({
        start(controller) {
          if (typeof generated.text === "string") {
            controller.enqueue({
              type: "text-delta",
              textDelta: generated.text,
            });
          }
          if (generated.toolCalls) {
            for (const tc of generated.toolCalls) {
              controller.enqueue({ type: "tool-call", ...tc });
            }
          }
          controller.enqueue({
            type: "finish",
            finishReason: generated.finishReason as any,
            usage: generated.usage,
          });
          controller.close();
        },
      });

      const responseHeaders = generated.rawResponse?.headers ?? {};

      return {
        stream,
        rawCall: generated.rawCall,
        rawResponse: { headers: responseHeaders },
        ...(generated.request ? { request: generated.request } : {}),
        ...(generated.warnings ? { warnings: generated.warnings } : {}),
      };
    } catch (e) {
      const stream = new ReadableStream<LanguageModelV1StreamPart>({
        start(controller) {
          controller.enqueue({ type: "error", error: e });
          controller.enqueue({
            type: "finish",
            finishReason: "error" as any,
            usage: { promptTokens: 0, completionTokens: 0 },
          });
          controller.close();
        },
      });

      return {
        stream,
        rawCall: {
          rawPrompt: { error: true },
          rawSettings: { durationMs: Date.now() - startedAt },
        },
        warnings: [],
      };
    }
  };

  const model: MastraLegacyLanguageModel = {
    specificationVersion: "v1",
    provider: "openrouter",
    modelId: cfg.grokModel,
    defaultObjectGenerationMode: "json",
    supportsStructuredOutputs: true,
    doGenerate,
    doStream,
  } satisfies LanguageModelV1;

  return model;
});

// ─── Agent factories ─────────────────────────────────────────────────────────

export const makeRepoQaAgent = (opts: {
  model: MastraLegacyLanguageModel;
  tools: ToolsInput;
}) =>
  new Agent({
    id: "repoQa",
    name: "repoQa",
    instructions:
      "You answer questions about a local directory by calling tools. Cite evidence by naming files and line numbers where possible. Never claim you read a file unless you used readFile. Prefer using searchText to locate relevant spots before readFile.",
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
      "You are a strict judge. You receive two candidate answers. Produce a single best answer that is concrete, structured, and does not invent file evidence.",
    model: opts.model,
    tools: {},
  });
