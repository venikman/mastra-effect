import { describe, expect, it } from "@rstest/core";
import { Effect } from "effect";
import {
  buildTextResponse,
  buildToolCallResponse,
  selectNextTool,
  generateSmartAnswer,
  createSmartMockClient,
} from "../mock/shared.js";
import type { OpenRouterChatCompletionRequest } from "../src/openrouter.js";

describe("mock/shared response builders", () => {
  it("buildTextResponse creates valid completion", () => {
    const res = buildTextResponse("hello");
    expect(res.body.choices[0]?.message.content).toBe("hello");
    expect(res.body.choices[0]?.finish_reason).toBe("stop");
    expect(res.headers["x-mock"]).toBe("true");
  });

  it("buildToolCallResponse creates valid tool call", () => {
    const res = buildToolCallResponse([
      { id: "tc1", name: "listFiles", arguments: { max: 10 } },
    ]);
    const tc = res.body.choices[0]?.message.tool_calls?.[0];
    expect(tc?.function.name).toBe("listFiles");
    expect(JSON.parse(tc?.function.arguments ?? "{}")).toEqual({ max: 10 });
    expect(res.body.choices[0]?.finish_reason).toBe("tool_calls");
  });
});

describe("mock/shared selectNextTool", () => {
  const makeBody = (calledToolNames: string[]): OpenRouterChatCompletionRequest => ({
    model: "m",
    messages: [
      { role: "user", content: "q" },
      ...calledToolNames.map((name) => ({
        role: "assistant" as const,
        content: null,
        tool_calls: [{ id: "x", type: "function" as const, function: { name, arguments: "{}" } }],
      })),
    ],
    stream: false,
  });

  it("selects searchText first if not called", () => {
    const tool = selectNextTool(makeBody([]), ["searchText", "readFile"]);
    expect(tool?.name).toBe("searchText");
  });

  it("selects readFile after searchText", () => {
    const tool = selectNextTool(makeBody(["searchText"]), ["searchText", "readFile"]);
    expect(tool?.name).toBe("readFile");
  });

  it("returns null when all tools called", () => {
    const tool = selectNextTool(makeBody(["searchText", "readFile"]), ["searchText", "readFile"]);
    expect(tool).toBeNull();
  });
});

describe("mock/shared generateSmartAnswer", () => {
  it("returns run instructions for run-related queries", () => {
    const answer = generateSmartAnswer("how do I run this?");
    expect(answer).toContain("npm install");
    expect(answer).toContain("Mock Response");
  });

  it("returns structure for architecture queries", () => {
    const answer = generateSmartAnswer("show me the file structure");
    expect(answer).toContain("src/");
    expect(answer).toContain("Mock Response");
  });

  it("returns generic analysis for other queries", () => {
    const answer = generateSmartAnswer("what is the meaning of life?");
    expect(answer).toContain("Effect-TS");
    expect(answer).toContain("Mock Response");
  });
});

describe("mock/shared createSmartMockClient", () => {
  it("starts with listFiles when available", async () => {
    const client = createSmartMockClient();
    const req: OpenRouterChatCompletionRequest = {
      model: "m",
      messages: [{ role: "user", content: "hello" }],
      tools: [{ type: "function", function: { name: "listFiles", parameters: {} } }],
      stream: false,
    };

    const res = await Effect.runPromise(client.chatCompletions(req));
    expect(res.body.choices[0]?.message.tool_calls?.[0]?.function.name).toBe("listFiles");
  });

  it("returns text when no tools available", async () => {
    const client = createSmartMockClient();
    const req: OpenRouterChatCompletionRequest = {
      model: "m",
      messages: [{ role: "user", content: "how do I run this?" }],
      stream: false,
    };

    const res = await Effect.runPromise(client.chatCompletions(req));
    expect(res.body.choices[0]?.message.content).toContain("Mock Response");
  });

  it("uses label prefix when provided", async () => {
    const client = createSmartMockClient({ label: "test:label" });
    const req: OpenRouterChatCompletionRequest = {
      model: "m",
      messages: [{ role: "user", content: "yo" }],
      stream: false,
    };

    const res = await Effect.runPromise(client.chatCompletions(req));
    expect(res.body.choices[0]?.message.content).toContain("(test:label)");
  });
});
