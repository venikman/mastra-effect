import { describe, expect, it } from "@rstest/core";
import { Cause, Effect, Option } from "effect";
import { readAppConfig } from "../src/config.js";

const withEnv = async (
  env: Record<string, string | undefined>,
  run: () => Promise<void>,
) => {
  const previous = { ...process.env };
  try {
    for (const [k, v] of Object.entries(env)) {
      if (typeof v === "undefined") delete process.env[k];
      else process.env[k] = v;
    }
    await run();
  } finally {
    for (const k of Object.keys(process.env)) {
      delete process.env[k];
    }
    Object.assign(process.env, previous);
  }
};

describe("config", () => {
  it("fails fast when GROK_KEY is missing", async () => {
    await withEnv(
      {
        GROK_KEY: undefined,
        GROK_MODEL: "openrouter/example-model",
      },
      async () => {
        const exit = await Effect.runPromiseExit(readAppConfig);
        expect(exit._tag).toBe("Failure");
        if (exit._tag !== "Failure") return;
        const err = Cause.failureOption(exit.cause);
        expect(Option.isSome(err)).toBe(true);
        if (!Option.isSome(err)) return;
        expect(err.value).toMatchObject({
          _tag: "ConfigError",
          key: "GROK_KEY",
        });
      },
    );
  });

  it("fails fast when GROK_MODEL is missing", async () => {
    await withEnv(
      {
        GROK_KEY: "k",
        GROK_MODEL: undefined,
      },
      async () => {
        const exit = await Effect.runPromiseExit(readAppConfig);
        expect(exit._tag).toBe("Failure");
        if (exit._tag !== "Failure") return;
        const err = Cause.failureOption(exit.cause);
        expect(Option.isSome(err)).toBe(true);
        if (!Option.isSome(err)) return;
        expect(err.value).toMatchObject({
          _tag: "ConfigError",
          key: "GROK_MODEL",
        });
      },
    );
  });
});
