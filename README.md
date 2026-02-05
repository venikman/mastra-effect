# Mastra × Effect Mini Lab (OpenRouter via `GROK_KEY` / `GROK_MODEL`)

This repo is a tiny, demo-first lab that combines Mastra agents with Effect for typed config, retries, concurrency, and structured logging. Inference runs through OpenRouter using `GROK_KEY` and `GROK_MODEL`, with optional mock flows for no-key local development.

## Quickstart

**Real LLM (OpenRouter)**

```bash
npm install
cp .env.example .env
# set GROK_KEY and GROK_MODEL in .env
npm run dev
# in another terminal:
npm run demo:qa
```

**Mock LLM (no API key)**

```bash
npm install
npm run dev:studio
# in another terminal:
npm run demo:qa
```

Alternatively, use the standalone mock server:

```bash
npm run dev:mock
# in another terminal:
npm run demo:qa
```

Demos are clients and require a running server, except `npm run demo:mock`.

## Setup

```bash
npm install
cp .env.example .env
```

Fill in `.env`:
- `GROK_KEY` = your OpenRouter API key
- `GROK_MODEL` = a model id (example: `anthropic/claude-3.7-sonnet`)

Optional:
- `DEMO_TARGET_DIR` (default `.`)
- `DEMO_QUESTION` (overrides demo question)

## Scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` | Mastra dev server + Studio (real LLM) |
| `npm run dev:studio` | Studio with mock OpenAI server (no key) |
| `npm run dev:mock` | Standalone mock Mastra API server on `:4111` |
| `npm run mock:openai` | Mock OpenAI-compatible server (used by `dev:studio`) |
| `npm run demo:qa` | Repo Q&A client demo (needs server) |
| `npm run demo:debate` | Parallel agents + judge demo (needs server) |
| `npm run demo:mock` | Local mock LLM examples (no server) |
| `npm test` | Vitest tests |
| `npm run typecheck` | TypeScript type check |

## Environment Variables

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `GROK_KEY` | Yes | | OpenRouter API key |
| `GROK_MODEL` | Yes | | OpenRouter model id |
| `OPENROUTER_BASE_URL` | No | `https://openrouter.ai/api/v1` | OpenRouter base URL |
| `LOG_LEVEL` | No | `info` | Log verbosity |
| `DEMO_TARGET_DIR` | No | `.` | Directory analyzed by repo Q&A demo |
| `DEMO_QUESTION` | No | | Overrides default demo question |
| `MASTRA_API_URL` | No | `http://localhost:4111` | Base URL for demo clients |
| `PORT` | No | `4111` | Mock server port |
| `MOCK_SCENARIO` | No | `smart` | Mock behavior (`smart` or `echo`) |

## Demo 1 — Repo Q&A with Tools

Runs one agent that can list files, search text, and read files (with safety rules). The demo is a **client** that talks to your running Mastra server; it does not import from `src`.

**Start the server first**, then run the demo:

```bash
npm run dev
# in another terminal:
npm run demo:qa
```

Optional: `MASTRA_API_URL` (default `http://localhost:4111`) — set in `.env` if the server runs elsewhere.

## Demo 2 — Two Agents + Judge (Effect concurrency)

Runs two agents **in parallel** (different prompts), then a judge agent merges. Same idea: client only, server must be running.

```bash
npm run dev
# in another terminal:
npm run demo:debate
```

Offline example runner (no server required):

```bash
npm run demo:mock
```

## Mastra Studio (Lab)

Run the interactive Studio UI and REST API so you can chat with the repo QA agent in the browser and call it via HTTP.

### With Real LLM (requires API key)

```bash
npm run dev
```

### With Mock LLM (no API key needed)

```bash
npm run dev:studio
```

This starts a mock OpenAI-compatible server alongside Mastra Studio - perfect for UI development and testing without API costs.

Then open:

- Studio UI — [http://localhost:4111/](http://localhost:4111/)
- REST API (Swagger) — [http://localhost:4111/swagger-ui](http://localhost:4111/swagger-ui)

Fastest no-key path: `npm run dev:studio`.

All four agents are registered: **repoQa**, **debaterA**, **debaterB**, and **judge**. Use them from the Agents tab or via the API. For a debate-style flow: chat with debaterA and debaterB on the same question, then paste both answers to the judge.

## Deep Dive / Code Map

- `src/config.ts` — env parsing + typed config errors
- `src/openrouter.ts` — OpenRouter client with retries + timeout (Effect)
- `src/tools.ts` — Effect-implemented tools + JSONL event log
- `src/mastra.ts` — Mastra agent setup + OpenRouter model adapter
- `demos/demo1_repo_qa.ts` — client that calls repoQa via API (no src dependency)
- `demos/demo2_debate.ts` — client that calls debaterA, debaterB, judge via API (no src dependency)
- `src/mastra/index.ts` — Mastra server entry (Studio + REST API)

Read next:
- `EFFECT_TS_REPORT.md`
- `mock/README.md`

## Tests (offline)

```bash
npm test
```

## Troubleshooting

- Missing `GROK_KEY`/`GROK_MODEL` when running `npm run dev` — add them to `.env`.
- OpenRouter 401/403 — verify your key and model id.
- Demo fails to connect — ensure server is running and `MASTRA_API_URL` matches.
- Port already in use — change `PORT` or stop the process using it.
- Mock flow not responding — make sure `npm run dev:studio` or `npm run dev:mock` is running.

## Notes

### `generateLegacy()`

Mastra `Agent.generate()` expects AI SDK v5+ models. This lab uses a small AI SDK v4-style adapter for simplicity, so the demos call `agent.generateLegacy()`.
