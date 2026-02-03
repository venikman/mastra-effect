/**
 * Mock LLM Client for local development without real AI calls.
 *
 * Provides configurable mock responses for testing and development
 * when OpenRouter/Grok API calls are not possible or desired.
 */
import { Effect, Layer } from "effect";
import { AppConfig, type AppConfig as AppConfigType } from "../src/config.js";
import {
  OpenRouterClient,
  type OpenRouterClient as OpenRouterClientType,
  type OpenRouterChatCompletionRequest,
  type OpenRouterChatCompletionResponse,
  type OpenRouterResponse,
} from "../src/openrouter.js";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type MockToolCall = {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};

export type MockResponse =
  | { type: "text"; content: string }
  | { type: "tool_call"; toolCalls: MockToolCall[] }
  | { type: "function"; handler: (request: OpenRouterChatCompletionRequest) => MockResponse };

export type MockScenario = {
  /** Human-readable name for the scenario */
  name: string;
  /** Ordered list of responses to return for each call */
  responses: MockResponse[];
  /** Optional delay in ms to simulate network latency */
  delayMs?: number;
};

// ─────────────────────────────────────────────────────────────────────────────
// Pre-built Mock Scenarios
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Simple scenario: returns a fixed text response immediately.
 */
export const simpleTextScenario = (text: string): MockScenario => ({
  name: "simple-text",
  responses: [{ type: "text", content: text }],
});

/**
 * Tool-then-answer scenario: first calls a tool, then returns text.
 * Common pattern for repo-qa agent testing.
 */
export const toolThenAnswerScenario = (
  toolCall: MockToolCall,
  finalAnswer: string,
): MockScenario => ({
  name: "tool-then-answer",
  responses: [
    { type: "tool_call", toolCalls: [toolCall] },
    { type: "text", content: finalAnswer },
  ],
});

/**
 * Multi-tool scenario: chains multiple tool calls before final answer.
 */
export const multiToolScenario = (
  toolCalls: MockToolCall[],
  finalAnswer: string,
): MockScenario => ({
  name: "multi-tool",
  responses: [
    ...toolCalls.map((tc) => ({ type: "tool_call" as const, toolCalls: [tc] })),
    { type: "text", content: finalAnswer },
  ],
});

/**
 * Echo scenario: echoes back the last user message.
 * Useful for debugging prompt construction.
 */
export const echoScenario: MockScenario = {
  name: "echo",
  responses: [
    {
      type: "function",
      handler: (req) => {
        const lastUserMsg = [...req.messages].reverse().find((m) => m.role === "user");
        const content = lastUserMsg?.content ?? "(no user message found)";
        return { type: "text", content: `Echo: ${content}` };
      },
    },
  ],
};

/**
 * Repo Q&A demo scenario: simulates a typical repo exploration flow.
 * 1. Lists files
 * 2. Searches for a term
 * 3. Reads a specific file
 * 4. Returns a comprehensive answer
 */
export const repoQaDemoScenario: MockScenario = {
  name: "repo-qa-demo",
  responses: [
    {
      type: "tool_call",
      toolCalls: [{ id: "tc1", name: "listFiles", arguments: { max: 50 } }],
    },
    {
      type: "tool_call",
      toolCalls: [{ id: "tc2", name: "searchText", arguments: { query: "export", maxMatches: 10 } }],
    },
    {
      type: "tool_call",
      toolCalls: [{ id: "tc3", name: "readFile", arguments: { path: "package.json" } }],
    },
    {
      type: "text",
      content: `## Repository Analysis (Mock Response)

Based on my exploration of the repository:

### Project Structure
- This is a TypeScript project using Effect-TS
- Key files found in src/, test/, and demos/ directories

### How to Run
1. Install dependencies: \`npm install\`
2. Run tests: \`npm test\`
3. Start dev server: \`npm run dev\`

### Key Files
- \`src/config.ts\` - Configuration management
- \`src/tools.ts\` - Tool definitions
- \`src/mastra.ts\` - Main Mastra integration

*Note: This is a mock response for local development.*`,
    },
  ],
  delayMs: 100,
};

// ─────────────────────────────────────────────────────────────────────────────
// Mock Client Implementation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates a mock OpenRouter client that returns predefined responses.
 */
export const createMockClient = (scenario: MockScenario): OpenRouterClientType => {
  let callIndex = 0;

  return {
    chatCompletions: (body: OpenRouterChatCompletionRequest) =>
      Effect.gen(function* () {
        // Apply optional delay
        if (scenario.delayMs && scenario.delayMs > 0) {
          yield* Effect.sleep(scenario.delayMs);
        }

        // Get current response (cycle if we run out)
        const responseIndex = callIndex % scenario.responses.length;
        const mockResponse = scenario.responses[responseIndex];
        if (!mockResponse) {
          throw new Error(`No mock response at index ${responseIndex}`);
        }
        callIndex++;

        // Resolve function-based responses
        const resolved =
          mockResponse.type === "function" ? mockResponse.handler(body) : mockResponse;

        // Build OpenRouter-compatible response
        const response = buildResponse(resolved, callIndex);

        console.log(
          `[MockLLM] Call #${callIndex} (${scenario.name}): ${resolved.type === "text" ? "text" : "tool_calls"}`,
        );

        return {
          body: response,
          headers: {
            "x-mock-scenario": scenario.name,
            "x-mock-call-index": String(callIndex),
          },
        } satisfies OpenRouterResponse<OpenRouterChatCompletionResponse>;
      }),
  };
};

const buildResponse = (
  mock: MockResponse,
  callIndex: number,
): OpenRouterChatCompletionResponse => {
  if (mock.type === "function") {
    throw new Error("Function response should be resolved before building");
  }

  if (mock.type === "text") {
    return {
      id: `mock-${callIndex}`,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: mock.content },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    };
  }

  // tool_call
  return {
    id: `mock-${callIndex}`,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: mock.toolCalls.map((tc) => ({
            id: tc.id,
            type: "function",
            function: {
              name: tc.name,
              arguments: JSON.stringify(tc.arguments),
            },
          })),
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// Layer Constructors
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates an Effect Layer with the mock client for a given scenario.
 */
export const MockClientLayer = (scenario: MockScenario) =>
  Layer.succeed(OpenRouterClient, createMockClient(scenario));

/**
 * Creates a mock AppConfig that doesn't require real env vars.
 */
export const MockConfigLayer = (overrides?: Partial<AppConfigType>) =>
  Layer.succeed(AppConfig, {
    grokKey: "mock-key",
    grokModel: "mock-model",
    baseUrl: "https://mock.local/api/v1",
    logLevel: "info",
    demoTargetDir: overrides?.demoTargetDir ?? ".",
    demoQuestion: overrides?.demoQuestion,
    ...overrides,
  } satisfies AppConfigType);

/**
 * Convenience: Combined mock layers for quick setup.
 */
export const MockLayers = (scenario: MockScenario, configOverrides?: Partial<AppConfigType>) =>
  Layer.mergeAll(MockClientLayer(scenario), MockConfigLayer(configOverrides));
