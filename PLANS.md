# ExecPlan: Effect-Only Runtime + Rstest Learning Tests

## Goal

Make this repo runnable and typecheckable without using `zod` in our source code, switch tests from Vitest to Rstest, and keep tests as lightweight learning examples (not a hard quality gate).

## Success criteria (observable)

- `npm run typecheck` passes.
- `npm test` passes using Rstest.
- `npm run dev:mock` starts (mock server) and demos can hit it (smoke-level).
- No project source files import `zod` (Mastra internals may still have a peer dependency; see Decisions log).

## Non-goals

- Full production-grade test coverage.
- Reworking Mastra/Studio UX beyond what’s required to keep the lab runnable.
- Changing Effect patterns already documented in `EFFECT_TS_REPORT.md` unless required for build/test.

## Constraints (sandbox, network, OS, time, dependencies)

- OS: macOS (workspace under `/Users/stas-studio`).
- Shell: `zsh`.
- Prefer minimal network usage; however adding Rstest requires downloading npm packages.
- Avoid destructive commands and irreversible migrations.

## Repo map (key files/dirs)

- `package.json`: scripts + deps.
- `.mastra/`: Mastra dev/build outputs + config (tracked in this repo).
- `src/config.ts`: env parsing (Effect).
- `src/openrouter.ts`: OpenRouter client (Effect, retries/timeouts).
- `src/mastra.ts`: Mastra legacy model adapter + agent factories.
- `src/tools.ts`: repo filesystem tools + tool logging (Effect).
- `mock/standalone-server.ts`: mock Mastra-compatible API server (no real LLM calls).
- `test/`: learning tests.

## Milestones

1. Restore basic repo hygiene
   - Steps
     - Restore `.mastra/bundler-config.mjs` and `.mastra/mastra-packages.json`.
     - Fix `.gitignore` typo for `package-lock.json`.
     - Restore and update `README.md` for the new stack (Effect + Rstest).
   - Validation: `git status -sb` shows expected changes only.
   - Rollback: `git checkout -- .mastra .gitignore README.md`

2. Drop Zod usage from repo code (Effect-only inputs)
   - Steps
     - Remove all `zod` imports from `src/`.
     - Replace Mastra tools that used `createTool + zod` with a minimal tool definition that:
       - exposes a JSON-schema-like `parameters` object for tool calling
       - does manual runtime validation/coercion inside `execute`
   - Validation: `rg -n "\\bzod\\b" src` returns no matches.
   - Rollback: `git checkout -- src`

3. Switch test runner from Vitest to Rstest (learning tests)
   - Steps
     - Add `@rstest/core` as a dev dependency and remove Vitest.
     - Add `rstest.config.ts`.
     - Migrate/simplify tests in `test/` to be Jest-compatible (Rstest).
   - Validation:
     - `npm test` passes.
   - Rollback: `git checkout -- test package.json rstest.config.ts` (and lockfile)

4. Full validation pass
   - Steps
     - Install deps and regenerate lockfile as needed.
     - Run typecheck + tests.
     - Smoke: start `npm run dev:mock` with a timeout and hit `/` once.
   - Validation:
     - `npm install`
     - `npm run typecheck`
     - `npm test`
     - `timeout 5 npm run dev:mock` (or start/stop instructions)
   - Rollback: `git checkout -- package.json package-lock.json` (and relevant files)

## Decisions log (why changes)

- We interpret “rstest” as the JavaScript test runner `@rstest/core` (Rspack-based, Jest-compatible), not the Rust crate `rstest`.
- We aim to remove `zod` from this repo’s source code. If Mastra’s published types/runtime require `zod` as a peer dependency, we may keep it installed only to satisfy Mastra, but not use it directly.

## Progress log (ISO-8601 timestamps)

- 2026-02-06:
  - Done: created plan; restored `.mastra/*`; fixed `.gitignore`; removed `zod` from `src/`; rewired `src/mastra/index.ts` to build agents via Effect/OpenRouter adapter with in-process mock mode; switched tests to `@rstest/core` and added `rstest.config.ts`; updated `package.json` scripts/deps accordingly.
  - Done: updated `README.md` and `.env.example`.
  - Done: validation passed.
  - Commands run:
    - `npm install` (ok)
    - `npm run typecheck` (ok)
    - `npm test` (ok, 5 files / 19 tests)
  - Next: optional commit changes.
  - Blockers: none.
  - Done: added Mermaid diagrams + updated composition snippet in `EFFECT_TS_REPORT.md`.
  - Done: converted Mermaid diagrams to ASCII-only diagrams in `EFFECT_TS_REPORT.md`.
  - Done: added additional ASCII diagrams for retry/timeout and repo tool safety pipeline.
  - Done: added ASCII diagrams for runOrThrow + Effect.exit logging/re-propagation.
  - Done: added ASCII diagram explaining how `Effect.provide(Layer)` satisfies the `R` environment.
  - Done: added ASCII diagram for `Layer.provideMerge(dep)(layer)` wiring.
  - Done: added diagrams index to `EFFECT_TS_REPORT.md`.
