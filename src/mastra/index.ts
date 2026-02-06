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
import { OpenRouterClient, OpenRouterClientLive } from "../openrouter.js";
import {
  makeOpenRouterLanguageModelV1,
  makeRepoQaAgent,
  makeDebaterAgent,
  makeJudgeAgent,
} from "../mastra.js";
import { EventLogLive, makeRepoTools } from "../tools.js";
import { createSmartMockClient } from "../../mock/shared.js";

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
  ? Layer.succeed(
      OpenRouterClient,
      createSmartMockClient({ label: `mock:${MOCK_SCENARIO || "smart"}` }),
    )
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
