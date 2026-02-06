#!/usr/bin/env npx tsx
/**
 * Standalone Mock Mastra Server
 *
 * Runs a mock Mastra-compatible API server without real LLM calls.
 * Uses Hono for routing, shared mock infrastructure for LLM simulation.
 *
 * Run with: npm run dev:mock
 * Then use exactly like the real server at http://localhost:4111
 */
import "dotenv/config";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import { Effect, Layer } from "effect";
import { AppConfig, type AppConfig as AppConfigType } from "../src/config.js";
import {
  makeOpenRouterLanguageModelV1,
  makeRepoQaAgent,
} from "../src/mastra.js";
import { OpenRouterClient } from "../src/openrouter.js";
import { EventLogLive, makeRepoTools } from "../src/tools.js";
import { createSmartMockClient } from "./shared.js";

// ─── Configuration ───────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT ?? "4111", 10);
const TARGET_DIR = process.env.DEMO_TARGET_DIR?.trim() || ".";
const MOCK_SCENARIO = process.env.MOCK_SCENARIO ?? "smart";

// ─── Build Agent ─────────────────────────────────────────────────────────────

const mockConfig: AppConfigType = {
  grokKey: "mock-key",
  grokModel: "mock-model",
  baseUrl: "https://mock.local/api/v1",
  logLevel: "info",
  demoTargetDir: TARGET_DIR,
  demoQuestion: undefined,
};

const MockLayers = Layer.mergeAll(
  Layer.succeed(AppConfig, mockConfig),
  Layer.succeed(OpenRouterClient, createSmartMockClient()),
  EventLogLive,
);

const buildAgent = async () => {
  const program = Effect.gen(function* () {
    const tools = yield* makeRepoTools(TARGET_DIR);
    const model = yield* makeOpenRouterLanguageModelV1;
    return makeRepoQaAgent({ model, tools });
  });
  return Effect.runPromise(program.pipe(Effect.provide(MockLayers)));
};

// ─── Hono App ────────────────────────────────────────────────────────────────

const startServer = async () => {
  const agent = await buildAgent();
  const app = new Hono();

  app.use("*", cors());

  // Health check
  app.get("/", (c) =>
    c.json({ status: "ok", mock: true, scenario: MOCK_SCENARIO }),
  );
  app.get("/health", (c) =>
    c.json({ status: "ok", mock: true, scenario: MOCK_SCENARIO }),
  );

  // List agents (with and without /api prefix)
  const agentList = [
    {
      id: "repoQa",
      name: "repo-qa",
      description: "Answers questions about a local directory",
    },
  ];

  app.get("/agents", (c) => c.json(agentList));
  app.get("/api/agents", (c) => c.json(agentList));

  // Agent details
  const agentDetail = (c: any) => {
    const agentId = c.req.param("agentId");
    if (agentId !== "repoQa")
      return c.json({ error: `Agent '${agentId}' not found` }, 404);
    return c.json({
      id: "repoQa",
      name: "repo-qa",
      description: "Answers questions about a local directory",
    });
  };
  app.get("/agents/:agentId", agentDetail);
  app.get("/api/agents/:agentId", agentDetail);

  // Generate (legacy + non-legacy)
  const generate = async (c: any) => {
    const agentId = c.req.param("agentId");
    if (agentId !== "repoQa")
      return c.json({ error: `Agent '${agentId}' not found` }, 404);

    const body = await c.req.json();
    const messages = body.messages ?? body.message ?? "";
    const prompt =
      typeof messages === "string" ? messages : JSON.stringify(messages);

    console.log(
      `[Server] Generating for agent '${agentId}': "${prompt.slice(0, 50)}..."`,
    );

    const result = await agent.generateLegacy(prompt);
    return c.json({
      text: result.text,
      toolCalls: result.toolCalls,
      usage: result.usage,
    });
  };

  app.post("/agents/:agentId/generate-legacy", generate);
  app.post("/api/agents/:agentId/generate-legacy", generate);
  app.post("/agents/:agentId/generate", generate);
  app.post("/api/agents/:agentId/generate", generate);

  serve({ fetch: app.fetch, port: PORT }, () => {
    console.log(`
Mock Mastra Server running at http://localhost:${PORT}
Scenario: ${MOCK_SCENARIO} | Target: ${TARGET_DIR}

  GET  /                              Health check
  GET  /agents                        List agents
  GET  /agents/repoQa                 Agent details
  POST /agents/repoQa/generate-legacy Generate response
`);
  });
};

startServer().catch((e) => {
  console.error("Failed to start server:", e);
  process.exit(1);
});
