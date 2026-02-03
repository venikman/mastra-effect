import { Context, Data, Effect, Layer } from "effect";

export type LogLevelName = "trace" | "debug" | "info" | "warn" | "error";

export type AppConfig = {
  grokKey: string;
  grokModel: string;
  baseUrl: string;
  logLevel: LogLevelName;
  demoTargetDir: string;
  demoQuestion: string | undefined;
};

export class ConfigError extends Data.TaggedError("ConfigError")<{
  key: string;
  message: string;
}> {}

export const AppConfig = Context.GenericTag<AppConfig>("AppConfig");

const normalizeBaseUrl = (input: string): string => input.replace(/\/+$/, "");

const parseLogLevel = (value: string | undefined): LogLevelName => {
  const lower = (value ?? "").toLowerCase();
  switch (lower) {
    case "trace":
    case "debug":
    case "info":
    case "warn":
    case "error":
      return lower as LogLevelName;
    default:
      return "info";
  }
};

const readRequiredEnv = (key: string) =>
  Effect.sync(() => process.env[key]).pipe(
    Effect.flatMap((value) => {
      const trimmed = value?.trim() ?? "";
      if (trimmed.length === 0) {
        return Effect.fail(
          new ConfigError({
            key,
            message: `Missing required env var ${key}`,
          }),
        );
      }
      return Effect.succeed(trimmed);
    }),
  );

export const readAppConfig = Effect.gen(function* () {
  const grokKey = yield* readRequiredEnv("GROK_KEY");
  const grokModel = yield* readRequiredEnv("GROK_MODEL");

  const baseUrl = normalizeBaseUrl(
    process.env.OPENROUTER_BASE_URL?.trim() || "https://openrouter.ai/api/v1",
  );

  const logLevel = parseLogLevel(process.env.LOG_LEVEL);
  const demoTargetDir = process.env.DEMO_TARGET_DIR?.trim() || ".";
  const demoQuestion = process.env.DEMO_QUESTION?.trim() || undefined;

  return {
    grokKey,
    grokModel,
    baseUrl,
    logLevel,
    demoTargetDir,
    demoQuestion,
  } satisfies AppConfig;
});

export const AppConfigLive = Layer.effect(AppConfig, readAppConfig);
