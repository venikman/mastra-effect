import { describe, expect, it } from "@rstest/core";
import { Effect } from "effect";
import {
  createMockClient,
  simpleTextScenario,
  toolThenAnswerScenario,
  multiToolScenario,
  echoScenario,
  repoQaDemoScenario,
} from "../mock/mock-llm.js";
import type { OpenRouterChatCompletionRequest } from "../src/openrouter.js";

const makeRequest = (content: string): OpenRouterChatCompletionRequest => ({
  model: "test-model",
  messages: [{ role: "user", content }],
  stream: false,
});

const call = (scenario: Parameters<typeof createMockClient>[0], req: OpenRouterChatCompletionRequest) =>
  Effect.runPromise(createMockClient(scenario).chatCompletions(req));

describe("mock-llm scenarios", () => {
  it("simpleTextScenario returns fixed text", async () => {
    const scenario = simpleTextScenario("hello world");
    const res = await call(scenario, makeRequest("anything"));

    expect(res.body.choices[0]?.message.content).toBe("hello world");
    expect(res.body.choices[0]?.finish_reason).toBe("stop");
    expect(res.headers["x-mock-scenario"]).toBe("simple-text");
  });

  it("toolThenAnswerScenario returns tool call then text", async () => {
    const scenario = toolThenAnswerScenario(
      { id: "tc1", name: "listFiles", arguments: { max: 10 } },
      "final answer",
    );
    const client = createMockClient(scenario);

    // First call: tool call
    const res1 = await Effect.runPromise(client.chatCompletions(makeRequest("q")));
    expect(res1.body.choices[0]?.message.tool_calls).toBeDefined();
    expect(res1.body.choices[0]?.message.tool_calls?.[0]?.function.name).toBe("listFiles");
    expect(res1.body.choices[0]?.finish_reason).toBe("tool_calls");

    // Second call: text answer
    const res2 = await Effect.runPromise(client.chatCompletions(makeRequest("q")));
    expect(res2.body.choices[0]?.message.content).toBe("final answer");
    expect(res2.body.choices[0]?.finish_reason).toBe("stop");
  });

  it("multiToolScenario chains tool calls before answer", async () => {
    const scenario = multiToolScenario(
      [
        { id: "tc1", name: "listFiles", arguments: {} },
        { id: "tc2", name: "searchText", arguments: { query: "foo" } },
      ],
      "done",
    );
    const client = createMockClient(scenario);

    const res1 = await Effect.runPromise(client.chatCompletions(makeRequest("q")));
    expect(res1.body.choices[0]?.message.tool_calls?.[0]?.function.name).toBe("listFiles");

    const res2 = await Effect.runPromise(client.chatCompletions(makeRequest("q")));
    expect(res2.body.choices[0]?.message.tool_calls?.[0]?.function.name).toBe("searchText");

    const res3 = await Effect.runPromise(client.chatCompletions(makeRequest("q")));
    expect(res3.body.choices[0]?.message.content).toBe("done");
  });

  it("echoScenario echoes user message", async () => {
    const res = await call(echoScenario, makeRequest("ping 123"));
    expect(res.body.choices[0]?.message.content).toBe("Echo: ping 123");
  });

  it("echoScenario handles missing user message", async () => {
    const req: OpenRouterChatCompletionRequest = {
      model: "test",
      messages: [{ role: "system", content: "you are a bot" }],
      stream: false,
    };
    const res = await call(echoScenario, req);
    expect(res.body.choices[0]?.message.content).toBe("Echo: (no user message found)");
  });

  it("repoQaDemoScenario has 4 steps (3 tools + answer)", async () => {
    const client = createMockClient(repoQaDemoScenario);

    const res1 = await Effect.runPromise(client.chatCompletions(makeRequest("q")));
    expect(res1.body.choices[0]?.message.tool_calls?.[0]?.function.name).toBe("listFiles");

    const res2 = await Effect.runPromise(client.chatCompletions(makeRequest("q")));
    expect(res2.body.choices[0]?.message.tool_calls?.[0]?.function.name).toBe("searchText");

    const res3 = await Effect.runPromise(client.chatCompletions(makeRequest("q")));
    expect(res3.body.choices[0]?.message.tool_calls?.[0]?.function.name).toBe("readFile");

    const res4 = await Effect.runPromise(client.chatCompletions(makeRequest("q")));
    expect(res4.body.choices[0]?.message.content).toContain("Repository Analysis");
  });

  it("cycles responses when exhausted", async () => {
    const scenario = simpleTextScenario("repeat me");
    const client = createMockClient(scenario);

    const res1 = await Effect.runPromise(client.chatCompletions(makeRequest("a")));
    const res2 = await Effect.runPromise(client.chatCompletions(makeRequest("b")));
    expect(res1.body.choices[0]?.message.content).toBe("repeat me");
    expect(res2.body.choices[0]?.message.content).toBe("repeat me");
  });

  it("includes usage in all responses", async () => {
    const res = await call(simpleTextScenario("x"), makeRequest("y"));
    expect(res.body.usage).toBeDefined();
    expect(res.body.usage?.total_tokens).toBeGreaterThan(0);
  });
});
