/**
 * Shared mock infrastructure used by standalone-server.ts and src/mastra/index.ts.
 *
 * Provides: response builders, smart answer generation, tool selection,
 * and a stateful smart mock client that sequences tool calls.
 */
import pino from "pino";
import { Effect } from "effect";
import {
  OpenRouterClient,
  type OpenRouterChatCompletionRequest,
  type OpenRouterChatCompletionResponse,
} from "../src/openrouter.js";

type OpenRouterClientType = OpenRouterClient;

// ─── Types ───────────────────────────────────────────────────────────────────

export type MockToolCall = {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};

export const mockLogger = pino({
  name: "mock",
  level: (process.env.LOG_LEVEL ?? "info").toLowerCase(),
  transport: { target: "pino/file", options: { destination: 1 } },
});

type MockOpenRouterResponse = {
  body: OpenRouterChatCompletionResponse;
  headers: Record<string, string>;
};

// ─── Response Builders ───────────────────────────────────────────────────────

export const buildTextResponse = (content: string): MockOpenRouterResponse => ({
  body: {
    id: `mock-${Date.now()}`,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 200, total_tokens: 300 },
  },
  headers: { "x-mock": "true" },
});

export const buildToolCallResponse = (
  toolCalls: MockToolCall[],
): MockOpenRouterResponse => ({
  body: {
    id: `mock-${Date.now()}`,
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
    usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 },
  },
  headers: { "x-mock": "true" },
});

// ─── Tool Selection ──────────────────────────────────────────────────────────

export const selectNextTool = (
  body: OpenRouterChatCompletionRequest,
  availableTools: string[],
): MockToolCall | null => {
  const calledTools = new Set<string>();
  for (const msg of body.messages) {
    if (msg.role === "assistant" && msg.tool_calls) {
      for (const tc of msg.tool_calls) calledTools.add(tc.function.name);
    }
  }

  if (!calledTools.has("searchText") && availableTools.includes("searchText"))
    return {
      id: `tc${Date.now()}`,
      name: "searchText",
      arguments: { query: "export", maxMatches: 10 },
    };

  if (!calledTools.has("readFile") && availableTools.includes("readFile"))
    return {
      id: `tc${Date.now()}`,
      name: "readFile",
      arguments: { path: "package.json" },
    };

  return null;
};

// ─── Smart Answer Generation ─────────────────────────────────────────────────

/** Extract a reasonable search term from a user query. */
export const extractSearchTerms = (query: string): string => {
  const lower = query.toLowerCase();
  if (lower.includes("run") || lower.includes("start")) return "npm run";
  if (lower.includes("test")) return "test";
  if (lower.includes("config")) return "config";
  if (lower.includes("export")) return "export";
  return "function";
};

export const generateSmartAnswer = (userQuery: string): string => {
  const query = userQuery.toLowerCase();

  if (
    query.includes("run") ||
    query.includes("start") ||
    query.includes("test") ||
    query.includes("how")
  ) {
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

  if (
    query.includes("structure") ||
    query.includes("architecture") ||
    query.includes("files")
  ) {
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

// ─── Smart Mock Client ───────────────────────────────────────────────────────

/**
 * Creates a stateful mock OpenRouter client that sequences tool calls
 * (listFiles → searchText → readFile → answer).
 *
 * @param label  Label prefix for final text responses (e.g. "mock:smart").
 *               If provided, prefixes the smart answer with `(label)\n\n`.
 */
export const createSmartMockClient = (opts?: {
  label?: string;
}): OpenRouterClientType => {
  const conversationStates = new Map<string, { toolsCalledCount: number }>();

  return OpenRouterClient.make({
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

        const makeAnswer = (text: string) =>
          opts?.label ? `(${opts.label})\n\n${text}` : text;

        if (hasToolResults) {
          state.toolsCalledCount++;

          if (state.toolsCalledCount >= 2) {
            conversationStates.delete(convKey);
            return buildTextResponse(
              makeAnswer(generateSmartAnswer(userContent)),
            );
          }

          const nextTool = selectNextTool(body, availableTools);
          if (nextTool) return buildToolCallResponse([nextTool]);

          conversationStates.delete(convKey);
          return buildTextResponse(
            makeAnswer(generateSmartAnswer(userContent)),
          );
        }

        if (
          state.toolsCalledCount === 0 &&
          availableTools.includes("listFiles")
        ) {
          return buildToolCallResponse([
            { id: "tc1", name: "listFiles", arguments: { max: 50 } },
          ]);
        }

        conversationStates.delete(convKey);
        return buildTextResponse(makeAnswer(generateSmartAnswer(userContent)));
      }),
  });
};
