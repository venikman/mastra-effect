/**
 * Example: Using Mock LLM for Local Development
 *
 * Run with: npx tsx mock/example-usage.ts
 *
 * This demonstrates how to use the mock LLM client for local development
 * when real AI API calls are not possible or not desired.
 */
import { Effect, Layer } from "effect";
import { EventLog, EventLogLive, makeRepoTools } from "../src/tools.js";
import { makeOpenRouterLanguageModelV1, makeRepoQaAgent } from "../src/mastra.js";
import {
  MockLayers,
  simpleTextScenario,
  toolThenAnswerScenario,
  repoQaDemoScenario,
  echoScenario,
  type MockScenario,
} from "./mock-llm.js";

// ─────────────────────────────────────────────────────────────────────────────
// Example 1: Simple Text Response
// ─────────────────────────────────────────────────────────────────────────────

async function exampleSimpleText() {
  console.log("\n" + "=".repeat(60));
  console.log("Example 1: Simple Text Response");
  console.log("=".repeat(60) + "\n");

  const scenario = simpleTextScenario(
    "Hello! This is a mock response. No API calls were made.",
  );

  const agent = await buildAgent(scenario, ".");
  const result = await agent.generateLegacy("Tell me something interesting.");

  console.log("\nAgent response:");
  console.log(result.text);
}

// ─────────────────────────────────────────────────────────────────────────────
// Example 2: Tool Call Then Answer
// ─────────────────────────────────────────────────────────────────────────────

async function exampleToolCall() {
  console.log("\n" + "=".repeat(60));
  console.log("Example 2: Tool Call Then Answer");
  console.log("=".repeat(60) + "\n");

  const scenario = toolThenAnswerScenario(
    { id: "tc1", name: "listFiles", arguments: { max: 10 } },
    "I found the files in your project. There are TypeScript files in src/ and test/ directories.",
  );

  // Use current directory as target
  const agent = await buildAgent(scenario, ".");
  const result = await agent.generateLegacy("What files are in this project?");

  console.log("\nAgent response:");
  console.log(result.text);
}

// ─────────────────────────────────────────────────────────────────────────────
// Example 3: Full Repo Q&A Demo Flow
// ─────────────────────────────────────────────────────────────────────────────

async function exampleRepoQaDemo() {
  console.log("\n" + "=".repeat(60));
  console.log("Example 3: Full Repo Q&A Demo (Multi-step)");
  console.log("=".repeat(60) + "\n");

  const agent = await buildAgent(repoQaDemoScenario, ".");
  const result = await agent.generateLegacy(
    "How do I run, test, and extend this repo?",
  );

  console.log("\nAgent response:");
  console.log(result.text);
}

// ─────────────────────────────────────────────────────────────────────────────
// Example 4: Echo Scenario (Debug Prompts)
// ─────────────────────────────────────────────────────────────────────────────

async function exampleEcho() {
  console.log("\n" + "=".repeat(60));
  console.log("Example 4: Echo Scenario (Debug)");
  console.log("=".repeat(60) + "\n");

  const agent = await buildAgent(echoScenario, ".");
  const result = await agent.generateLegacy(
    "This message should be echoed back to verify prompt handling.",
  );

  console.log("\nAgent response:");
  console.log(result.text);
}

// ─────────────────────────────────────────────────────────────────────────────
// Example 5: Custom Scenario
// ─────────────────────────────────────────────────────────────────────────────

async function exampleCustomScenario() {
  console.log("\n" + "=".repeat(60));
  console.log("Example 5: Custom Scenario");
  console.log("=".repeat(60) + "\n");

  // Create a custom scenario with specific behavior
  const customScenario: MockScenario = {
    name: "custom-debug-flow",
    responses: [
      // First: search for "Effect"
      {
        type: "tool_call",
        toolCalls: [
          { id: "search1", name: "searchText", arguments: { query: "Effect", maxMatches: 5 } },
        ],
      },
      // Then: read the config file
      {
        type: "tool_call",
        toolCalls: [
          { id: "read1", name: "readFile", arguments: { path: "src/config.ts" } },
        ],
      },
      // Finally: return analysis
      {
        type: "text",
        content: `## Custom Analysis Result

I searched for "Effect" usage and found it in multiple files.
The config.ts file shows how Effect-TS is used for configuration management.

Key observations:
- Uses Effect.gen for generator-based composition
- Defines custom error types with Data.TaggedError
- Exports Layer-based dependency injection

*This response was generated by a custom mock scenario.*`,
      },
    ],
    delayMs: 50, // Small delay to simulate network
  };

  const agent = await buildAgent(customScenario, ".");
  const result = await agent.generateLegacy("Analyze how Effect-TS is used in this project.");

  console.log("\nAgent response:");
  console.log(result.text);
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: Build Agent with Mock
// ─────────────────────────────────────────────────────────────────────────────

async function buildAgent(scenario: MockScenario, targetDir: string) {
  const layers = Layer.mergeAll(
    MockLayers(scenario, { demoTargetDir: targetDir }),
    EventLogLive,
  );

  return Effect.runPromise(
    Effect.gen(function* () {
      const tools = yield* makeRepoTools(targetDir);
      const model = yield* makeOpenRouterLanguageModelV1;
      return makeRepoQaAgent({ model, tools });
    }).pipe(Effect.provide(layers)),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n🧪 Mock LLM Examples - Local Development without AI Calls\n");

  await exampleSimpleText();
  await exampleToolCall();
  await exampleRepoQaDemo();
  await exampleEcho();
  await exampleCustomScenario();

  console.log("\n" + "=".repeat(60));
  console.log("✅ All examples completed successfully!");
  console.log("=".repeat(60) + "\n");
}

main().catch((e) => {
  console.error("Error:", e);
  process.exit(1);
});
