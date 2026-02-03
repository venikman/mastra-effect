#!/usr/bin/env npx tsx
/**
 * OpenAI-Compatible Mock Server
 *
 * This server mimics the OpenAI API format, allowing Mastra Studio to run
 * without real API calls. It implements the /v1/chat/completions endpoint.
 *
 * Usage:
 *   npm run mock:openai    # Start mock on port 4222
 *   npm run dev:studio     # Start both mock server + mastra dev
 */
import * as http from "node:http";

const PORT = parseInt(process.env.MOCK_PORT ?? "4222", 10);
const MOCK_SCENARIO = process.env.MOCK_SCENARIO ?? "smart";

// Track conversation state for multi-turn tool usage
const conversationStates = new Map<string, { callCount: number }>();

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

// ─────────────────────────────────────────────────────────────────────────────
// Response Builders
// ─────────────────────────────────────────────────────────────────────────────

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

const buildToolCallResponse = (
  toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>,
  model: string
) => ({
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
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.arguments),
          },
        })),
      },
      finish_reason: "tool_calls",
    },
  ],
  usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 },
});

// ─────────────────────────────────────────────────────────────────────────────
// Smart Mock Logic
// ─────────────────────────────────────────────────────────────────────────────

const generateSmartResponse = (request: ChatRequest): ReturnType<typeof buildTextResponse> => {
  const model = request.model;
  const lastUserMsg = [...request.messages].reverse().find((m) => m.role === "user");
  const userContent = lastUserMsg?.content ?? "";
  const hasToolResults = request.messages.some((m) => m.role === "tool");
  const availableTools = request.tools?.map((t) => t.function.name) ?? [];

  // Create conversation key for state tracking
  const firstUserMsg = request.messages.find((m) => m.role === "user");
  const convKey = firstUserMsg?.content?.slice(0, 50) ?? "default";

  if (!conversationStates.has(convKey)) {
    conversationStates.set(convKey, { callCount: 0 });
  }
  const state = conversationStates.get(convKey)!;
  state.callCount++;

  console.log(`[MockOpenAI] Conv: "${convKey.slice(0, 30)}..." | Call #${state.callCount} | Tools: ${availableTools.join(", ") || "none"}`);

  // If we have tool results and have done enough tool calls, answer
  if (hasToolResults && state.callCount >= 3) {
    conversationStates.delete(convKey);
    return buildTextResponse(generateAnswer(userContent), model);
  }

  // If we have tool results, maybe call more tools
  if (hasToolResults) {
    const calledTools = getCalledTools(request.messages);
    const nextTool = selectNextTool(calledTools, availableTools, userContent);
    if (nextTool) {
      return buildToolCallResponse([nextTool], model);
    }
    // No more tools to call, answer
    conversationStates.delete(convKey);
    return buildTextResponse(generateAnswer(userContent), model);
  }

  // Initial call - start with listFiles if available
  if (state.callCount === 1 && availableTools.includes("listFiles")) {
    return buildToolCallResponse(
      [{ id: `tc-${Date.now()}`, name: "listFiles", arguments: { max: 50 } }],
      model
    );
  }

  // Fallback to text response
  conversationStates.delete(convKey);
  return buildTextResponse(generateAnswer(userContent), model);
};

const getCalledTools = (messages: ChatMessage[]): Set<string> => {
  const called = new Set<string>();
  for (const msg of messages) {
    if (msg.role === "assistant" && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        called.add(tc.function.name);
      }
    }
  }
  return called;
};

const selectNextTool = (
  calledTools: Set<string>,
  availableTools: string[],
  userQuery: string
): { id: string; name: string; arguments: Record<string, unknown> } | null => {
  // If user is searching for something specific, use searchText
  if (!calledTools.has("searchText") && availableTools.includes("searchText")) {
    const searchTerms = extractSearchTerms(userQuery);
    return {
      id: `tc-${Date.now()}`,
      name: "searchText",
      arguments: { query: searchTerms, maxMatches: 10 },
    };
  }

  // Read a relevant file
  if (!calledTools.has("readFile") && availableTools.includes("readFile")) {
    return {
      id: `tc-${Date.now()}`,
      name: "readFile",
      arguments: { path: "package.json" },
    };
  }

  return null;
};

const extractSearchTerms = (query: string): string => {
  const lower = query.toLowerCase();
  if (lower.includes("run") || lower.includes("start")) return "npm run";
  if (lower.includes("test")) return "test";
  if (lower.includes("config")) return "config";
  if (lower.includes("export")) return "export";
  return "function";
};

const generateAnswer = (userQuery: string): string => {
  const query = userQuery.toLowerCase();

  if (query.includes("run") || query.includes("start") || query.includes("how")) {
    return `## How to Run This Project (Mock Response)

Based on my analysis of the repository:

### Quick Start
\`\`\`bash
npm install
npm run dev      # Start development server
npm test         # Run tests
\`\`\`

### Available Scripts
- \`npm run dev\` - Start Mastra development server with Studio
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

// ─────────────────────────────────────────────────────────────────────────────
// Echo Mode (simple debugging)
// ─────────────────────────────────────────────────────────────────────────────

const generateEchoResponse = (request: ChatRequest) => {
  const lastMsg = [...request.messages].reverse().find((m) => m.role === "user");
  const content = `[Echo] You said: "${lastMsg?.content ?? "(nothing)"}"`;
  return buildTextResponse(content, request.model);
};

// ─────────────────────────────────────────────────────────────────────────────
// HTTP Server
// ─────────────────────────────────────────────────────────────────────────────

const parseBody = (req: http.IncomingMessage): Promise<unknown> =>
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

const sendJson = (res: http.ServerResponse, status: number, data: unknown) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  console.log(`[MockOpenAI] ${req.method} ${url.pathname}`);

  try {
    // Health check
    if (url.pathname === "/" || url.pathname === "/health") {
      sendJson(res, 200, { status: "ok", mock: true, scenario: MOCK_SCENARIO });
      return;
    }

    // Models endpoint (Mastra/Vercel AI SDK may call this)
    if (url.pathname === "/v1/models") {
      sendJson(res, 200, {
        object: "list",
        data: [
          { id: "gpt-4o-mini", object: "model", owned_by: "mock" },
          { id: "gpt-4o", object: "model", owned_by: "mock" },
          { id: "gpt-4", object: "model", owned_by: "mock" },
        ],
      });
      return;
    }

    // Chat completions - the main endpoint
    if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
      const body = (await parseBody(req)) as ChatRequest;

      // Add artificial delay to simulate real API
      await new Promise((r) => setTimeout(r, 100));

      const response =
        MOCK_SCENARIO === "echo"
          ? generateEchoResponse(body)
          : generateSmartResponse(body);

      sendJson(res, 200, response);
      return;
    }

    // 404 for unknown routes
    sendJson(res, 404, { error: { message: "Not found", type: "not_found" } });
  } catch (error) {
    console.error("[MockOpenAI] Error:", error);
    sendJson(res, 500, {
      error: { message: String(error), type: "server_error" },
    });
  }
});

server.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║              🤖 MOCK OPENAI-COMPATIBLE SERVER                ║
╠══════════════════════════════════════════════════════════════╣
║  Server running at: http://localhost:${String(PORT).padEnd(25)}║
║  Mock scenario: ${MOCK_SCENARIO.padEnd(44)}║
║                                                              ║
║  Endpoints:                                                  ║
║    GET  /                        Health check                ║
║    GET  /v1/models               List models                 ║
║    POST /v1/chat/completions     Chat completions            ║
║                                                              ║
║  To use with Mastra Studio:                                  ║
║    OPENAI_BASE_URL=http://localhost:${PORT} mastra dev          ║
╚══════════════════════════════════════════════════════════════╝
`);
});
