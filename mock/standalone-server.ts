#!/usr/bin/env npx tsx
/**
 * Standalone Mock Mastra Server
 *
 * Runs a mock Mastra-compatible API server without real LLM calls.
 * This server exposes the same endpoints as the real Mastra dev server.
 *
 * Run with: npm run dev:mock
 * Then use exactly like the real server at http://localhost:4111
 */
import "dotenv/config";
import * as http from "node:http";
import { Effect, Layer } from "effect";
import { AppConfig, type AppConfig as AppConfigType } from "../src/config.js";
import { makeOpenRouterLanguageModelV1, makeRepoQaAgent } from "../src/mastra.js";
import { OpenRouterClient, type OpenRouterChatCompletionRequest } from "../src/openrouter.js";
import { EventLog, EventLogLive, makeRepoTools } from "../src/tools.js";
import type { MockToolCall } from "./mock-llm.js";

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT ?? "4111", 10);
const TARGET_DIR = process.env.DEMO_TARGET_DIR?.trim() || ".";
const MOCK_SCENARIO = process.env.MOCK_SCENARIO ?? "smart";

// ─────────────────────────────────────────────────────────────────────────────
// Smart Mock LLM Client
// ─────────────────────────────────────────────────────────────────────────────

const createSmartMockClient = (): typeof OpenRouterClient.Type => {
  const conversationStates = new Map<string, { toolsCalledCount: number }>();

  return {
    chatCompletions: (body: OpenRouterChatCompletionRequest) =>
      Effect.gen(function* () {
        yield* Effect.sleep(50);

        // Create a conversation key based on the first user message
        const firstUserMsg = body.messages.find((m) => m.role === "user");
        const convKey = firstUserMsg?.content?.slice(0, 50) ?? "default";

        if (!conversationStates.has(convKey)) {
          conversationStates.set(convKey, { toolsCalledCount: 0 });
        }
        const state = conversationStates.get(convKey)!;

        const lastUserMsg = [...body.messages].reverse().find((m) => m.role === "user");
        const userContent = lastUserMsg?.content ?? "";
        const hasToolResults = body.messages.some((m) => m.role === "tool");
        const availableTools = body.tools?.map((t) => t.function.name) ?? [];

        console.log(`[MockLLM] Conversation: "${convKey.slice(0, 30)}...", Tools called: ${state.toolsCalledCount}`);

        // If we've received tool results, decide whether to call more tools or answer
        if (hasToolResults) {
          state.toolsCalledCount++;

          // After 2-3 tool calls, provide final answer
          if (state.toolsCalledCount >= 2) {
            // Clean up state
            conversationStates.delete(convKey);
            return buildTextResponse(generateSmartAnswer(userContent));
          }

          // Call another tool based on what we haven't called yet
          const nextTool = selectNextTool(body, availableTools);
          if (nextTool) {
            return buildToolCallResponse([nextTool]);
          }

          // No more tools to call, answer
          conversationStates.delete(convKey);
          return buildTextResponse(generateSmartAnswer(userContent));
        }

        // Initial call - start with listFiles
        if (state.toolsCalledCount === 0 && availableTools.includes("listFiles")) {
          return buildToolCallResponse([
            { id: "tc1", name: "listFiles", arguments: { max: 50 } },
          ]);
        }

        // Fallback to simple answer
        conversationStates.delete(convKey);
        return buildTextResponse(generateSmartAnswer(userContent));
      }),
  };
};

const selectNextTool = (
  body: OpenRouterChatCompletionRequest,
  availableTools: string[],
): MockToolCall | null => {
  const calledTools = new Set<string>();
  for (const msg of body.messages) {
    if (msg.role === "assistant" && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        calledTools.add(tc.function.name);
      }
    }
  }

  if (!calledTools.has("searchText") && availableTools.includes("searchText")) {
    return { id: `tc${Date.now()}`, name: "searchText", arguments: { query: "export", maxMatches: 10 } };
  }

  if (!calledTools.has("readFile") && availableTools.includes("readFile")) {
    return { id: `tc${Date.now()}`, name: "readFile", arguments: { path: "package.json" } };
  }

  return null;
};

const generateSmartAnswer = (userQuery: string): string => {
  const query = userQuery.toLowerCase();

  if (query.includes("run") || query.includes("start") || query.includes("test")) {
    return `## How to Run This Project (Mock Response)

Based on my analysis of the repository:

### Quick Start
\`\`\`bash
npm install
npm run dev      # Start development server
npm test         # Run tests
\`\`\`

### Available Scripts
- \`npm run dev\` - Start Mastra development server
- \`npm run dev:mock\` - Start mock server (no API calls)
- \`npm run demo:qa\` - Run the Q&A demo
- \`npm test\` - Run test suite

### Key Files
- \`src/config.ts\` - Configuration management
- \`src/mastra.ts\` - Main Mastra integration
- \`src/tools.ts\` - Tool definitions

*Note: This is a mock response for local development without API calls.*`;
  }

  if (query.includes("structure") || query.includes("architecture") || query.includes("files")) {
    return `## Repository Structure (Mock Response)

\`\`\`
├── src/           # Source code
│   ├── config.ts  # Configuration
│   ├── mastra.ts  # Mastra integration
│   ├── openrouter.ts  # OpenRouter client
│   └── tools.ts   # Tool definitions
├── test/          # Test files
├── demos/         # Demo scripts
├── mock/          # Mock LLM for local dev
└── package.json   # Dependencies
\`\`\`

*Note: This is a mock response for local development without API calls.*`;
  }

  return `## Analysis (Mock Response)

I've analyzed the repository and here's what I found:

1. This is a TypeScript project using Effect-TS
2. It integrates with Mastra for AI agent functionality
3. Uses OpenRouter for LLM access

For more specific information, please ask about:
- How to run/test the project
- Repository structure
- Specific files or features

*Note: This is a mock response for local development without API calls.*`;
};

const buildTextResponse = (content: string) => ({
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

const buildToolCallResponse = (toolCalls: MockToolCall[]) => ({
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

// ─────────────────────────────────────────────────────────────────────────────
// Build Agent
// ─────────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────
// HTTP Server (Mastra-compatible API)
// ─────────────────────────────────────────────────────────────────────────────

const parseBody = (req: http.IncomingMessage): Promise<any> =>
  new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });

const sendJson = (res: http.ServerResponse, status: number, data: any) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
};

const startServer = async () => {
  const agent = await buildAgent();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
    const path = url.pathname;

    // CORS headers
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // Normalize path - remove /api prefix if present (MastraClient adds it)
    const normalizedPath = path.startsWith("/api") ? path.slice(4) : path;

    console.log(`[Server] ${req.method} ${path} -> ${normalizedPath}`);

    try {
      // Health check
      if (normalizedPath === "/" || normalizedPath === "/health" || path === "/" || path === "/health") {
        sendJson(res, 200, { status: "ok", mock: true, scenario: MOCK_SCENARIO });
        return;
      }

      // List agents
      if (normalizedPath === "/agents" && req.method === "GET") {
        sendJson(res, 200, [
          {
            id: "repoQa",
            name: "repo-qa",
            description: "Answers questions about a local directory",
          },
        ]);
        return;
      }

      // Agent details
      const detailsMatch = normalizedPath.match(/^\/agents\/([^/]+)$/);
      if (detailsMatch && req.method === "GET") {
        const agentId = detailsMatch[1];
        if (agentId !== "repoQa") {
          sendJson(res, 404, { error: `Agent '${agentId}' not found` });
          return;
        }
        sendJson(res, 200, {
          id: "repoQa",
          name: "repo-qa",
          description: "Answers questions about a local directory",
        });
        return;
      }

      // Agent generate-legacy - this is what MastraClient.getAgent().generateLegacy() calls
      const legacyMatch = normalizedPath.match(/^\/agents\/([^/]+)\/generate-legacy$/);
      if (legacyMatch && req.method === "POST") {
        const agentId = legacyMatch[1];
        if (agentId !== "repoQa") {
          sendJson(res, 404, { error: `Agent '${agentId}' not found` });
          return;
        }

        const body = await parseBody(req);
        const messages = body.messages ?? body.message ?? "";
        const prompt = typeof messages === "string" ? messages : JSON.stringify(messages);

        console.log(`[Server] Generating for agent '${agentId}': "${prompt.slice(0, 50)}..."`);

        const result = await agent.generateLegacy(prompt);

        sendJson(res, 200, {
          text: result.text,
          toolCalls: result.toolCalls,
          usage: result.usage,
        });
        return;
      }

      // Agent generate (non-legacy) - also support this endpoint
      const generateMatch = normalizedPath.match(/^\/agents\/([^/]+)\/generate$/);
      if (generateMatch && req.method === "POST") {
        const agentId = generateMatch[1];
        if (agentId !== "repoQa") {
          sendJson(res, 404, { error: `Agent '${agentId}' not found` });
          return;
        }

        const body = await parseBody(req);
        const messages = body.messages ?? body.message ?? "";
        const prompt = typeof messages === "string" ? messages : JSON.stringify(messages);

        console.log(`[Server] Generating for agent '${agentId}': "${prompt.slice(0, 50)}..."`);

        const result = await agent.generateLegacy(prompt);

        sendJson(res, 200, {
          text: result.text,
          toolCalls: result.toolCalls,
          usage: result.usage,
        });
        return;
      }

      // 404
      sendJson(res, 404, { error: "Not found", path, normalizedPath });
    } catch (error) {
      console.error("[Server] Error:", error);
      sendJson(res, 500, { error: String(error) });
    }
  });

  server.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════════════════════════╗
║                    🧪 MOCK MASTRA SERVER                     ║
╠══════════════════════════════════════════════════════════════╣
║  Server running at: http://localhost:${String(PORT).padEnd(25)}║
║  Mock scenario: ${MOCK_SCENARIO.padEnd(44)}║
║  Target directory: ${TARGET_DIR.padEnd(41)}║
║                                                              ║
║  Endpoints:                                                  ║
║    GET  /                              Health check          ║
║    GET  /agents                        List agents           ║
║    GET  /agents/repoQa                 Agent details         ║
║    POST /agents/repoQa/generate-legacy Generate response     ║
║                                                              ║
║  Use with: npm run demo:qa                                   ║
║  Or: curl -X POST http://localhost:${PORT}/agents/repoQa/generate-legacy \\ ║
║       -H "Content-Type: application/json" \\                  ║
║       -d '{"messages": "How do I run this project?"}'        ║
╚══════════════════════════════════════════════════════════════╝
`);
  });
};

startServer().catch((e) => {
  console.error("Failed to start server:", e);
  process.exit(1);
});
