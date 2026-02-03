# Mastra × Effect Mini Lab (OpenRouter via `GROK_KEY` / `GROK_MODEL`)

This repo is intentionally tiny and demo-first:

- **Mastra**: agents + tool calling
- **Effect**: typed config/errors, retries, concurrency, structured logging
- **Inference**: **OpenRouter** using env vars `GROK_KEY` and `GROK_MODEL`

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

- **Studio UI** — [http://localhost:4111/](http://localhost:4111/)
- **REST API (Swagger)** — [http://localhost:4111/swagger-ui](http://localhost:4111/swagger-ui)

All four agents are registered: **repoQa**, **debaterA**, **debaterB**, and **judge**. Use them from the Agents tab or via the API. For a debate-style flow: chat with debaterA and debaterB on the same question, then paste both answers to the judge.

## Where to learn (read these files)

- `src/config.ts` — env parsing + typed config errors
- `src/openrouter.ts` — OpenRouter client with retries + timeout (Effect)
- `src/tools.ts` — Effect-implemented tools + JSONL event log
- `src/mastra.ts` — Mastra agent setup + OpenRouter model adapter
- `demos/demo1_repo_qa.ts` — client that calls repoQa via API (no src dependency)
- `demos/demo2_debate.ts` — client that calls debaterA, debaterB, judge via API (no src dependency)
- `src/mastra/index.ts` — Mastra server entry (Studio + REST API)

## Tests (offline)

```bash
npm test
```

## Note on `generateLegacy()`

Mastra `Agent.generate()` expects AI SDK v5+ models. This lab uses a small AI SDK v4-style adapter for simplicity, so the demos call `agent.generateLegacy()`.
