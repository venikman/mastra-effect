#!/usr/bin/env npx tsx
/**
 * OpenAI-Compatible Mock Server
 *
 * Mimics the OpenAI API format using Hono, allowing Mastra Studio to run
 * without real API calls. Implements /v1/chat/completions.
 *
 * Uses shared answer generation and tool selection from mock/shared.ts.
 * Response builders are local because OpenAI responses need `object`, `created`,
 * and `model` fields that the OpenRouter-shaped shared builders don't include.
 */
import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import {
  generateSmartAnswer,
  extractSearchTerms,
  mockLogger,
  type MockToolCall,
} from "./shared.js";

const log = mockLogger.child({ server: "openai" });

const PORT = parseInt(process.env.MOCK_PORT ?? "4222", 10);
const MOCK_SCENARIO = process.env.MOCK_SCENARIO ?? "smart";

// ─── Types ───────────────────────────────────────────────────────────────────

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: Array<{
    type: "function";
    function: { name: string; description?: string; parameters?: unknown };
  }>;
  stream?: boolean;
}

// ─── Conversation State ──────────────────────────────────────────────────────

const conversationStates = new Map<string, { callCount: number }>();

// ─── OpenAI-shaped Response Builders ─────────────────────────────────────────

const buildTextResponse = (content: string, model: string) => ({
  id: `chatcmpl-mock-${Date.now()}`,
  object: "chat.completion",
  created: Math.floor(Date.now() / 1000),
  model,
  choices: [
    {
      index: 0,
      message: { role: "assistant", content },
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 100, completion_tokens: 200, total_tokens: 300 },
});

const buildToolCallResponse = (toolCalls: MockToolCall[], model: string) => ({
  id: `chatcmpl-mock-${Date.now()}`,
  object: "chat.completion",
  created: Math.floor(Date.now() / 1000),
  model,
  choices: [
    {
      index: 0,
      message: {
        role: "assistant",
        content: null,
        tool_calls: toolCalls.map((tc) => ({
          id: tc.id,
          type: "function" as const,
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
        })),
      },
      finish_reason: "tool_calls",
    },
  ],
  usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 },
});

// ─── Smart Mock Logic ────────────────────────────────────────────────────────

const getCalledTools = (messages: ChatMessage[]): Set<string> => {
  const called = new Set<string>();
  for (const msg of messages) {
    if (msg.role === "assistant" && msg.tool_calls) {
      for (const tc of msg.tool_calls) called.add(tc.function.name);
    }
  }
  return called;
};

const selectNextTool = (
  calledTools: Set<string>,
  availableTools: string[],
  userQuery: string,
): MockToolCall | null => {
  if (!calledTools.has("searchText") && availableTools.includes("searchText"))
    return {
      id: `tc-${Date.now()}`,
      name: "searchText",
      arguments: { query: extractSearchTerms(userQuery), maxMatches: 10 },
    };
  if (!calledTools.has("readFile") && availableTools.includes("readFile"))
    return {
      id: `tc-${Date.now()}`,
      name: "readFile",
      arguments: { path: "package.json" },
    };
  return null;
};

const generateSmartResponse = (request: ChatRequest) => {
  const model = request.model;
  const lastUserMsg = [...request.messages]
    .reverse()
    .find((m) => m.role === "user");
  const userContent = lastUserMsg?.content ?? "";
  const hasToolResults = request.messages.some((m) => m.role === "tool");
  const availableTools = request.tools?.map((t) => t.function.name) ?? [];

  const firstUserMsg = request.messages.find((m) => m.role === "user");
  const convKey = firstUserMsg?.content?.slice(0, 50) ?? "default";

  if (!conversationStates.has(convKey))
    conversationStates.set(convKey, { callCount: 0 });
  const state = conversationStates.get(convKey)!;
  state.callCount++;

  log.debug(
    {
      conv: convKey.slice(0, 30),
      call: state.callCount,
      tools: availableTools,
    },
    "chat",
  );

  if (hasToolResults && state.callCount >= 3) {
    conversationStates.delete(convKey);
    return buildTextResponse(generateSmartAnswer(userContent), model);
  }

  if (hasToolResults) {
    const calledTools = getCalledTools(request.messages);
    const nextTool = selectNextTool(calledTools, availableTools, userContent);
    if (nextTool) return buildToolCallResponse([nextTool], model);
    conversationStates.delete(convKey);
    return buildTextResponse(generateSmartAnswer(userContent), model);
  }

  if (state.callCount === 1 && availableTools.includes("listFiles")) {
    return buildToolCallResponse(
      [{ id: `tc-${Date.now()}`, name: "listFiles", arguments: { max: 50 } }],
      model,
    );
  }

  conversationStates.delete(convKey);
  return buildTextResponse(generateSmartAnswer(userContent), model);
};

// ─── Hono App ────────────────────────────────────────────────────────────────

const app = new Hono();
app.use("*", cors());

app.get("/", (c) =>
  c.json({ status: "ok", mock: true, scenario: MOCK_SCENARIO }),
);
app.get("/health", (c) =>
  c.json({ status: "ok", mock: true, scenario: MOCK_SCENARIO }),
);

app.get("/v1/models", (c) =>
  c.json({
    object: "list",
    data: [
      { id: "gpt-4o-mini", object: "model", owned_by: "mock" },
      { id: "gpt-4o", object: "model", owned_by: "mock" },
      { id: "gpt-4", object: "model", owned_by: "mock" },
    ],
  }),
);

app.post("/v1/chat/completions", async (c) => {
  const body = (await c.req.json()) as ChatRequest;
  await new Promise((r) => setTimeout(r, 100));

  const response =
    MOCK_SCENARIO === "echo"
      ? buildTextResponse(
          `[Echo] You said: "${[...body.messages].reverse().find((m) => m.role === "user")?.content ?? "(nothing)"}"`,
          body.model,
        )
      : generateSmartResponse(body);

  return c.json(response);
});

serve({ fetch: app.fetch, port: PORT }, () => {
  log.info({ port: PORT, scenario: MOCK_SCENARIO }, "server started");
});
