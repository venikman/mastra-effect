import * as Fs from "node:fs/promises";
import * as Os from "node:os";
import * as Path from "node:path";
import { describe, expect, it } from "@rstest/core";
import { Effect, Layer } from "effect";
import { AppConfig, type AppConfig as AppConfigType } from "../src/config.js";
import {
  makeOpenRouterLanguageModelV1,
  makeRepoQaAgent,
} from "../src/mastra.js";
import {
  OpenRouterClient,
  type OpenRouterChatCompletionRequest,
} from "../src/openrouter.js";

type OpenRouterClientType = OpenRouterClient;
import { EventLog, makeRepoTools, type ToolEvent } from "../src/tools.js";

const makeTempDir = async (): Promise<string> => {
  const dir = await Fs.mkdtemp(Path.join(Os.tmpdir(), "mastra-effect-it-"));
  return dir;
};

describe("integration (fake LLM)", () => {
  it("executes one tool call then finishes", async () => {
    const dir = await makeTempDir();
    await Fs.writeFile(Path.join(dir, "a.txt"), "hello\n", "utf8");

    const events: ToolEvent[] = [];

    let calls = 0;
    const fakeClient: OpenRouterClientType = OpenRouterClient.make({
      chatCompletions: (body: OpenRouterChatCompletionRequest) =>
        Effect.sync(() => {
          calls++;
          if (calls === 1) {
            // First model call: request a tool.
            return {
              body: {
                id: "1",
                choices: [
                  {
                    index: 0,
                    message: {
                      role: "assistant",
                      content: null,
                      tool_calls: [
                        {
                          id: "tc1",
                          type: "function",
                          function: {
                            name: "listFiles",
                            arguments: JSON.stringify({ max: 5 }),
                          },
                        },
                      ],
                    },
                    finish_reason: "tool_calls",
                  },
                ],
                usage: { prompt_tokens: 1, completion_tokens: 1 },
              },
              headers: {},
            };
          }

          // Second model call: final answer.
          return {
            body: {
              id: "2",
              choices: [
                {
                  index: 0,
                  message: { role: "assistant", content: "Done." },
                  finish_reason: "stop",
                },
              ],
              usage: { prompt_tokens: 1, completion_tokens: 1 },
            },
            headers: {},
          };
        }),
    });

    const cfg: AppConfigType = {
      grokKey: "k",
      grokModel: "m",
      baseUrl: "https://openrouter.ai/api/v1",
      logLevel: "info",
      demoTargetDir: dir,
      demoQuestion: undefined,
    };

    const LiveLayers = [
      Layer.succeed(AppConfig, cfg),
      Layer.succeed(OpenRouterClient, fakeClient),
      Layer.succeed(
        EventLog,
        EventLog.make({
          emit: (event) => Effect.sync(() => void events.push(event)),
        }),
      ),
    ] as const;

    const agent = await Effect.runPromise(
      Effect.gen(function* () {
        const tools = yield* makeRepoTools(dir);
        const model = yield* makeOpenRouterLanguageModelV1;
        return makeRepoQaAgent({ model, tools });
      }).pipe(Effect.provide(LiveLayers)),
    );

    const out = await agent.generateLegacy("List files then say Done.");
    expect(out.text).toContain("Done.");

    expect(
      events.some((e) => e.type === "tool:start" && e.tool === "listFiles"),
    ).toBe(true);
    expect(
      events.some((e) => e.type === "tool:success" && e.tool === "listFiles"),
    ).toBe(true);
  });
});
