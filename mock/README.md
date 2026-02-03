# Mock LLM Module

This folder provides a mock LLM client for local development when real AI API calls are not possible or desired.

## Why Use Mocks?

- **No API Key Required**: Develop and test without OpenRouter/Grok credentials
- **Offline Development**: Work without internet connectivity
- **Predictable Results**: Get consistent responses for testing
- **Cost-Free**: No API usage costs during development
- **Fast Iteration**: Instant responses without network latency

## Quick Start

### Option 1: Mastra Studio with Mock (recommended for UI development)

Run Mastra Studio/Playground with a mock LLM backend - full UI experience without API calls:

```bash
npm run dev:studio
```

This starts:
- Mock OpenAI-compatible server on port 4222
- Mastra Studio on http://localhost:4111

Open http://localhost:4111 in your browser to use the Playground UI with mock responses!

### Option 2: Run Mock API Server

Start the mock Mastra API server - use it exactly like the real server:

```bash
# Terminal 1: Start the mock server (runs on http://localhost:4111)
npm run dev:mock

# Terminal 2: Run the demo (works exactly like with real server)
npm run demo:qa
```

The mock server exposes the same API as the real Mastra dev server, so all demos and client code work unchanged. No API keys or environment variables required!

**Environment Variables:**
- `PORT` - Server port (default: 4111)
- `DEMO_TARGET_DIR` - Directory to analyze (default: ".")
- `MOCK_SCENARIO` - Mock behavior: "smart" (default) or "echo"

### Option 2: Run Examples Directly

```bash
# Run the example demonstrating all mock scenarios
npm run demo:mock
```

## Usage in Your Code

### 1. Simple Text Response

```typescript
import { Effect, Layer } from "effect";
import { MockLayers, simpleTextScenario } from "./mock/mock-llm.js";
import { makeOpenRouterLanguageModelV1, makeRepoQaAgent } from "./src/mastra.js";
import { makeRepoTools, EventLogLive } from "./src/tools.js";

const scenario = simpleTextScenario("This is a mock response!");

const layers = Layer.mergeAll(
  MockLayers(scenario),
  EventLogLive,
);

const agent = await Effect.runPromise(
  Effect.gen(function* () {
    const tools = yield* makeRepoTools(".");
    const model = yield* makeOpenRouterLanguageModelV1;
    return makeRepoQaAgent({ model, tools });
  }).pipe(Effect.provide(layers)),
);

const result = await agent.generateLegacy("Hello!");
console.log(result.text); // "This is a mock response!"
```

### 2. Tool Call Then Answer

Simulates the agent calling a tool before returning a final answer:

```typescript
import { toolThenAnswerScenario } from "./mock/mock-llm.js";

const scenario = toolThenAnswerScenario(
  { id: "tc1", name: "listFiles", arguments: { max: 10 } },
  "I found 5 TypeScript files in the project.",
);
```

### 3. Multi-Tool Scenario

Chain multiple tool calls before the final answer:

```typescript
import { multiToolScenario } from "./mock/mock-llm.js";

const scenario = multiToolScenario(
  [
    { id: "tc1", name: "listFiles", arguments: { max: 50 } },
    { id: "tc2", name: "searchText", arguments: { query: "export" } },
    { id: "tc3", name: "readFile", arguments: { path: "src/config.ts" } },
  ],
  "Based on my analysis, this is a TypeScript project using Effect-TS...",
);
```

### 4. Custom Dynamic Scenario

Create scenarios with dynamic responses based on the request:

```typescript
import type { MockScenario } from "./mock/mock-llm.js";

const customScenario: MockScenario = {
  name: "my-custom-scenario",
  responses: [
    {
      type: "function",
      handler: (request) => {
        // Access the request to build dynamic response
        const hasTools = request.tools && request.tools.length > 0;
        return {
          type: "text",
          content: hasTools
            ? "I see you have tools available!"
            : "No tools provided.",
        };
      },
    },
  ],
  delayMs: 100, // Optional: simulate network latency
};
```

## Pre-built Scenarios

| Scenario | Description |
|----------|-------------|
| `simpleTextScenario(text)` | Returns a fixed text response |
| `toolThenAnswerScenario(tool, answer)` | Calls one tool, then returns text |
| `multiToolScenario(tools[], answer)` | Chains multiple tools, then returns text |
| `echoScenario` | Echoes back the user's message (debug) |
| `repoQaDemoScenario` | Full demo: list files → search → read → answer |

## Layer Helpers

```typescript
// Just the mock client
MockClientLayer(scenario)

// Just the mock config (no env vars needed)
MockConfigLayer({ demoTargetDir: "./my-project" })

// Both combined
MockLayers(scenario, { demoTargetDir: "./my-project" })
```

## Testing with Mocks

The mock client is ideal for unit and integration tests:

```typescript
import { describe, it, expect } from "vitest";
import { simpleTextScenario, MockLayers } from "../mock/mock-llm.js";

describe("MyAgent", () => {
  it("handles simple queries", async () => {
    const scenario = simpleTextScenario("Test response");
    const layers = Layer.mergeAll(MockLayers(scenario), EventLogSilent);
    
    const agent = await Effect.runPromise(
      buildAgent().pipe(Effect.provide(layers))
    );
    
    const result = await agent.generateLegacy("Test question");
    expect(result.text).toBe("Test response");
  });
});
```

## Console Output

When using the mock client, you'll see log messages like:

```
[MockLLM] Call #1 (repo-qa-demo): tool_calls
[MockLLM] Call #2 (repo-qa-demo): tool_calls
[MockLLM] Call #3 (repo-qa-demo): tool_calls
[MockLLM] Call #4 (repo-qa-demo): text
```

This helps track the mock's behavior during development.
