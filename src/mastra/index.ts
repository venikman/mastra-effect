/**
 * Mastra Entry Point for Studio/Playground
 *
 * This file exports the Mastra instance required by `mastra dev` to run Studio.
 * It supports both real LLM mode and mock mode via environment variables.
 *
 * Usage:
 *   npm run dev          # Real mode (requires GROK_KEY)
 *   npm run dev:studio   # Mock mode (no API key needed)
 */
import "dotenv/config";
import { Mastra } from "@mastra/core";
import { createLogger, type LogLevel } from "@mastra/core/logger";
import { Effect, Layer } from "effect";
import {
  AppConfig,
  AppConfigLive,
  type AppConfig as AppConfigType,
} from "../config.js";
import {
  OpenRouterClient,
  OpenRouterClientLive,
  type OpenRouterChatCompletionRequest,
  type OpenRouterChatCompletionResponse,
  type OpenRouterClient as OpenRouterClientType,
} from "../openrouter.js";
import {
  makeOpenRouterLanguageModelV1,
  makeRepoQaAgent,
  makeDebaterAgent,
  makeJudgeAgent,
} from "../mastra.js";
import { EventLogLive, makeRepoTools } from "../tools.js";

const parseMastraLogLevel = (value: string | undefined): LogLevel => {
  const v = (value ?? "").trim().toLowerCase();
  switch (v) {
    case "debug":
    case "info":
    case "warn":
    case "error":
    case "silent":
      return v;
    case "trace":
      return "debug";
    default:
      return "info";
  }
};

const logger = createLogger({
  name: "mastra",
  level: parseMastraLogLevel(process.env.LOG_LEVEL),
});

const MOCK_SCENARIO = (process.env.MOCK_SCENARIO ?? "").trim();
const USE_MOCK = process.env.MOCK_MODE === "1" || MOCK_SCENARIO.length > 0;

const buildTextResponse = (
  content: string,
): {
  body: OpenRouterChatCompletionResponse;
  headers: Record<string, string>;
} => ({
  body: {
    id: `mock-${Date.now()}`,
    choices: [
      {
        index: 0,
        message: { role: "assistant" as const, content },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 200, total_tokens: 300 },
  },
  headers: { "x-mock": "true" },
});

const buildToolCallResponse = (
  toolCalls: Array<{ id: string; name: string; arguments: unknown }>,
) => ({
  body: {
    id: `mock-${Date.now()}`,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant" as const,
          content: null,
          tool_calls: toolCalls.map((tc) => ({
            id: tc.id,
            type: "function" as const,
            function: {
              name: tc.name,
              arguments: JSON.stringify(tc.arguments),
            },
          })),
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 },
  },
  headers: { "x-mock": "true" },
});

const createSmartMockClient = (): OpenRouterClientType => {
  const conversationStates = new Map<string, { toolsCalledCount: number }>();

  return {
    chatCompletions: (body: OpenRouterChatCompletionRequest) =>
      Effect.gen(function* () {
        yield* Effect.sleep(50);

        const firstUserMsg = body.messages.find((m) => m.role === "user");
        const convKey = firstUserMsg?.content?.slice(0, 50) ?? "default";

        if (!conversationStates.has(convKey)) {
          conversationStates.set(convKey, { toolsCalledCount: 0 });
        }
        const state = conversationStates.get(convKey)!;

        const lastUserMsg = [...body.messages]
          .reverse()
          .find((m) => m.role === "user");
        const userContent = lastUserMsg?.content ?? "";
        const hasToolResults = body.messages.some((m) => m.role === "tool");
        const availableTools = body.tools?.map((t) => t.function.name) ?? [];

        if (hasToolResults) {
          state.toolsCalledCount++;

          if (state.toolsCalledCount >= 2) {
            conversationStates.delete(convKey);
            return buildTextResponse(
              `(mock:${MOCK_SCENARIO || "smart"})\n\nI used tools and now I can answer:\n\n${userContent}`,
            );
          }

          // Prefer searching, then reading package.json.
          const calledTools = new Set<string>();
          for (const msg of body.messages) {
            if (msg.role === "assistant" && msg.tool_calls) {
              for (const tc of msg.tool_calls)
                calledTools.add(tc.function.name);
            }
          }

          if (
            !calledTools.has("searchText") &&
            availableTools.includes("searchText")
          ) {
            return buildToolCallResponse([
              {
                id: `tc${Date.now()}`,
                name: "searchText",
                arguments: { query: "export", maxMatches: 10 },
              },
            ]);
          }
          if (
            !calledTools.has("readFile") &&
            availableTools.includes("readFile")
          ) {
            return buildToolCallResponse([
              {
                id: `tc${Date.now()}`,
                name: "readFile",
                arguments: { path: "package.json" },
              },
            ]);
          }

          conversationStates.delete(convKey);
          return buildTextResponse(
            `(mock:${MOCK_SCENARIO || "smart"})\n\nNo more tools to call.\n\n${userContent}`,
          );
        }

        // Initial call: list files if available.
        if (
          state.toolsCalledCount === 0 &&
          availableTools.includes("listFiles")
        ) {
          return buildToolCallResponse([
            { id: "tc1", name: "listFiles", arguments: { max: 50 } },
          ]);
        }

        conversationStates.delete(convKey);
        return buildTextResponse(
          `(mock:${MOCK_SCENARIO || "smart"})\n\n${userContent}`,
        );
      }),
  };
};

const targetDir = process.env.DEMO_TARGET_DIR?.trim() || ".";

const mockConfig: AppConfigType = {
  grokKey: "mock-key",
  grokModel: "mock-model",
  baseUrl: "https://mock.local/api/v1",
  logLevel: "info",
  demoTargetDir: targetDir,
  demoQuestion: undefined,
};

const ConfigLayer = USE_MOCK
  ? Layer.succeed(AppConfig, mockConfig)
  : AppConfigLive;
const ClientLayer = USE_MOCK
  ? Layer.succeed(OpenRouterClient, createSmartMockClient())
  : OpenRouterClientLive;

const LiveLayers = Layer.mergeAll(
  Layer.provideMerge(ConfigLayer)(ClientLayer),
  EventLogLive,
);

const agents = await Effect.runPromise(
  Effect.gen(function* () {
    const cfg = yield* AppConfig;
    const tools = yield* makeRepoTools(cfg.demoTargetDir);
    const model = yield* makeOpenRouterLanguageModelV1;

    const repoQa = makeRepoQaAgent({ model, tools });
    const debaterA = makeDebaterAgent({
      id: "debaterA",
      instructions:
        "You are Debater A. Be concrete and cite evidence from tool outputs when available. If you lack evidence, say what tool calls are needed.",
      model,
      tools,
    });
    const debaterB = makeDebaterAgent({
      id: "debaterB",
      instructions:
        "You are Debater B. Focus on risks and edge-cases. Cite evidence from tool outputs when available. If you lack evidence, say what tool calls are needed.",
      model,
      tools,
    });
    const judge = makeJudgeAgent({ model });

    return { repoQa, debaterA, debaterB, judge } as const;
  }).pipe(Effect.provide(LiveLayers)),
);

export const mastra = new Mastra({
  agents,
  logger,
});
