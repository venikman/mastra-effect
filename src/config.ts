import { cleanEnv, str, makeValidator } from "envalid";
import { Context, Data, Effect, Layer } from "effect";

export type LogLevelName = "trace" | "debug" | "info" | "warn" | "error";

const logLevel = makeValidator<LogLevelName>((input) => {
  const lower = (input ?? "").toLowerCase();
  if (
    lower === "trace" ||
    lower === "debug" ||
    lower === "info" ||
    lower === "warn" ||
    lower === "error"
  )
    return lower;
  throw new Error(`Invalid log level: ${input}`);
});

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

/** Custom reporter that throws instead of calling process.exit */
const throwingReporter = <T>({
  errors,
}: {
  errors: Partial<Record<keyof T, Error>>;
}) => {
  const missing = Object.keys(errors) as string[];
  if (missing.length > 0) {
    const first = missing[0]!;
    throw new ConfigError({
      key: first,
      message: `Missing required env var ${first}`,
    });
  }
};

export const readAppConfig = Effect.try({
  try: () => {
    const env = cleanEnv(
      process.env,
      {
        GROK_KEY: str({ desc: "API key for OpenRouter / Grok" }),
        GROK_MODEL: str({ desc: "Model identifier" }),
        OPENROUTER_BASE_URL: str({ default: "https://openrouter.ai/api/v1" }),
        LOG_LEVEL: logLevel({ default: "info" }),
        DEMO_TARGET_DIR: str({ default: "." }),
        DEMO_QUESTION: str({ default: "" }),
      },
      { reporter: throwingReporter },
    );

    return {
      grokKey: env.GROK_KEY,
      grokModel: env.GROK_MODEL,
      baseUrl: env.OPENROUTER_BASE_URL.replace(/\/+$/, ""),
      logLevel: env.LOG_LEVEL,
      demoTargetDir: env.DEMO_TARGET_DIR,
      demoQuestion: env.DEMO_QUESTION || undefined,
    } satisfies AppConfig;
  },
  catch: (e) => {
    if (e instanceof ConfigError) return e;
    const msg = e instanceof Error ? e.message : String(e);
    return new ConfigError({ key: "unknown", message: msg });
  },
});

export const AppConfigLive = Layer.effect(AppConfig, readAppConfig);
