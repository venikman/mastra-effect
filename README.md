# Mastra × Effect Mini Lab (OpenRouter via `GROK_KEY` / `GROK_MODEL`)

This repo is a demo-first lab that combines:

- **Mastra** for agents + Studio (`mastra dev`)
- **Effect** for typed config, retries/timeouts, dependency injection (Layers), and structured tool logging
- **OpenRouter** as the LLM gateway (via `GROK_KEY` / `GROK_MODEL`)

This repo intentionally avoids `zod` in its own source code; tool inputs use JSON-Schema-like `parameters` plus lightweight runtime validation in `execute`.

## Quickstart

### Real LLM (OpenRouter)

```bash
npm install
cp .env.example .env
# set GROK_KEY and GROK_MODEL in .env
npm run dev
```

Then in another terminal:

```bash
npm run demo:qa
```

### Mock LLM (no API key)

Runs Mastra Studio/API but uses an in-process mock OpenRouter client (no external mock server needed):

```bash
npm install
npm run dev:studio
```

Then in another terminal:

```bash
npm run demo:qa
```

### Standalone Mock Server (no `mastra dev`)

This runs a tiny Mastra-compatible HTTP API implemented in `mock/standalone-server.ts`:

```bash
npm install
npm run dev:mock
```

Then in another terminal:

```bash
npm run demo:qa
```

## Scripts

| Command               | Purpose                                             |
| --------------------- | --------------------------------------------------- |
| `npm run dev`         | Mastra dev server + Studio (real OpenRouter LLM)    |
| `npm run dev:studio`  | Mastra dev server + Studio with in-process mock LLM |
| `npm run dev:mock`    | Standalone mock Mastra API server on `:4111`        |
| `npm run demo:qa`     | Repo Q&A client demo (needs a running server)       |
| `npm run demo:debate` | Two debaters + judge demo (needs a running server)  |
| `npm run demo:mock`   | Local mock LLM examples (no server required)        |
| `npm test`            | Run learning tests (Rstest)                         |
| `npm run typecheck`   | TypeScript type check                               |

## Environment Variables

| Variable              | Required       | Default                        | Description                                                         |
| --------------------- | -------------- | ------------------------------ | ------------------------------------------------------------------- |
| `GROK_KEY`            | Real mode only |                                | OpenRouter API key                                                  |
| `GROK_MODEL`          | Real mode only |                                | OpenRouter model id (example: `anthropic/claude-3.7-sonnet`)        |
| `OPENROUTER_BASE_URL` | No             | `https://openrouter.ai/api/v1` | OpenRouter base URL                                                 |
| `LOG_LEVEL`           | No             | `info`                         | Log verbosity                                                       |
| `DEMO_TARGET_DIR`     | No             | `.`                            | Directory analyzed by repo tools                                    |
| `DEMO_QUESTION`       | No             |                                | Overrides demo question                                             |
| `MASTRA_API_URL`      | No             | `http://localhost:4111`        | Base URL for demo clients                                           |
| `MOCK_MODE`           | No             |                                | If `1`, uses in-process mock OpenRouter client (Mastra Studio mode) |
| `MOCK_SCENARIO`       | No             |                                | Optional scenario label for mock mode (ex: `smart`)                 |
| `PORT`                | No             | `4111`                         | Standalone mock server port (`npm run dev:mock`)                    |

## Demos

### Demo 1: Repo Q&A (tools)

Client demo that calls the `repoQa` agent over HTTP:

```bash
npm run demo:qa
```

### Demo 2: Two Debaters + Judge

Calls `debaterA` and `debaterB` in parallel, then merges with `judge`:

```bash
npm run demo:debate
```

## Code Map

### `src/` — core runtime

| File              | Purpose                                                                    |
| ----------------- | -------------------------------------------------------------------------- |
| `config.ts`       | Env parsing via `envalid` + typed `ConfigError` (Effect Layer)             |
| `openrouter.ts`   | OpenRouter client with retries + timeout (Effect Layer)                    |
| `http-effect.ts`  | Reusable HTTP primitives: `fetchWithTimeout`, `retrySchedule`, error types |
| `effect-utils.ts` | Shared Effect helpers (`runOrThrow`)                                       |
| `tools.ts`        | Repo tools (listFiles, searchText, readFile) + JSONL event log (Effect)    |
| `mastra.ts`       | LanguageModelV1 adapter + agent factories (repoQa, debater, judge)         |
| `mastra/index.ts` | `mastra dev` entrypoint — builds agents, supports mock mode                |

### `mock/` — local development without API keys

All mock infrastructure for running demos, Studio, and tests without real LLM calls.

| File                    | Purpose                                                                          |
| ----------------------- | -------------------------------------------------------------------------------- |
| `shared.ts`             | Shared response builders, smart answer generation, stateful mock client          |
| `mock-llm.ts`           | Configurable scenario-based mock client (simpleText, toolThenAnswer, echo, etc.) |
| `standalone-server.ts`  | Mastra-compatible HTTP API on `:4111` (Hono)                                     |
| `openai-mock-server.ts` | OpenAI-compatible `/v1/chat/completions` mock (Hono)                             |
| `example-usage.ts`      | Runnable examples of all mock scenarios                                          |

### Docs

- `EFFECT_TS_REPORT.md` — deeper notes on how Effect-TS is used here

## Tests (learning)

```bash
npm test
```

## Notes

### `generateLegacy()`

This lab uses Mastra’s legacy generation API for compatibility with the AI SDK v4-shaped model adapter in `src/mastra.ts`, so the demos call `agent.generateLegacy()`.
