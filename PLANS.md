# ExecPlan: Fix Sandbox Symlink Escape + Smart Mock Label Regression

## Goal
Prevent sandbox escape via symlink traversal in repo tools, and ensure mock mode continues to return smart mock answers even when a label is provided.

## Success criteria (observable)
- `listFiles` does not follow symlinked directories and does not return symlink entries.
- `readFile` denies reads where the realpath resolves outside the configured root.
- `createSmartMockClient({ label })` prefixes output but still uses `generateSmartAnswer(...)`.
- `npm test` passes.
- `npm run typecheck` passes.

## Non-goals
- Hardening against hard-link exfiltration.
- Adding write/delete filesystem tools.
- Changing mock scenario selection logic beyond the label behavior.

## Constraints (sandbox, network, OS, time, dependencies)
- OS: macOS (local dev); tests may run on Linux/Windows in CI.
- Avoid dependency upgrades.
- Avoid network calls.
- Keep changes small and reviewable.

## Repo map (key files/dirs)
- `src/tools.ts`: repo tool implementations (`listFiles`, `searchText`, `readFile`).
- `mock/shared.ts`: smart mock client implementation.
- `test/tools.test.ts`: repo tool tests.
- `test/mock-shared.test.ts`: mock client tests.

## Milestones
1. Block symlink traversal + symlink escapes in repo tools
   - Steps
     - Disable symlink following in `listFilesEffect` and filter out symlink entries.
     - Add a realpath-based check for `readFile` to deny symlink escapes outside root.
   - Validation: `npm test` (expect all tests pass)
   - Rollback: `git revert <commit>`
2. Preserve smart answers when `label` is provided in smart mock client
   - Steps
     - Treat `label` as a pure prefix; always generate smart answers.
     - Update/add tests to lock behavior.
   - Validation: `npm test` + `npm run typecheck` (expect pass)
   - Rollback: `git revert <commit>`

## Decisions log (why changes)
- `fast-glob` follows symlinks by default; set `followSymbolicLinks: false` and filter symlink entries to match the previous non-symlink-walking behavior.
- `resolveInsideRoot` is string-based; add a `realpath` containment check to prevent symlink-based sandbox escapes in `readFile`.
- `label` should not change mock semantics; it now only prefixes `generateSmartAnswer(...)` output.

## Progress log (ISO-8601 timestamps)
- 2026-02-06T03:35:37Z
  - Done: Implemented symlink protections + label-prefix fix; added regression tests.
  - Next: Commit changes.
  - Blockers: None.
