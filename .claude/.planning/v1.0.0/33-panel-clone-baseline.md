# 33 — Panel: clone and baseline

**Status:** done locally · **Depends on:** 00 · **Phase:** 2

## Goal

Bring the Qelay Control Panel into `packages/panel` as a working baseline (D8: copied and diverged), building, linting and testing green inside this repo, before any behaviour changes.

## Scope

In: copy, rename, licence and provenance, fix the build, keep the unit tests that still apply, record what is deleted.
Out: wiring to the Control API (34), new pages (35).

## Steps

1. **Copy** from `../qelay-control-panel` at a recorded commit into `packages/panel` (source, tests, configs). Exclude `node_modules`, `dist`, `.git`, build output, the panel's own `.claude/` planning folders, and any local environment files. Record the source commit in `docs/PORTING.md`.
2. **Licence:** keep the panel's MIT notice and add the `Copyright (c) 2026 ChxisB` line per D5 if it is not already there.
3. **Rename and rebrand:** package name `@qelay-cloud/panel`; product name strings and the document title; leave the panel's visual design alone. Check the panel's rules against its own `CLAUDE.md` (English only, structure and file-size gate) and follow them for any file touched.
4. **Make the workspace work:** reconcile dependency versions with the root workspace; unify TypeScript, Oxlint and Oxfmt configs with the root (the panel's are the source for the root, so this should be a no-op); keep the 300-line gate on `packages/panel` as the panel already has it.
5. **Triage the tests:** run the panel's unit tests. Classify each failing or irrelevant suite: keep, adapt later (needs the Control API), or delete with a reason. Do not weaken assertions to get green; delete a suite only when the feature it tests is out of scope, and list it.
6. **Triage the features** (`src/features/{backups,fleet,flows,queue-operations,workflows}`, `agent/`): mark each as keep, hide-by-capability (task 34), or remove. Remove dead code for `agent/{server,backup,db}` that only serves the Qelay TCP server and SQLite, unless task 34 decides to keep them behind capabilities.
7. **Dev run:** `bun run dev` for the panel boots against a stub server returning the existing mock/fixture data, so the UI is viewable before the real API is wired.
8. **E2E (`e2e/`):** keep the Playwright setup, mark specs that need the live Qelay as skipped with a tracking note, and make the remainder pass.

## Acceptance

- `bun install && bun run typecheck && bun run lint && bun run format:check && bun run architecture` passes for the workspace including `packages/panel`.
- Panel unit tests that apply are green; every deleted or skipped suite is listed in `docs/PORTING.md` with the reason.
- `packages/panel` boots and renders its pages against the stub.
- The source commit and licence notices are recorded.

## Verify

```bash
bun install
bun run typecheck && bun run lint && bun run format:check && bun run architecture
bun test packages/panel
bun run --cwd packages/panel build
```

## Risks / notes

- About 282 test files and a large feature tree: budget the triage honestly; this is the largest mechanical task in Phase 2.
- Keep the clone minimal and reviewable: behaviour changes belong in task 34 and 35, not here.
- D8 means upstream panel fixes will not flow in automatically. Note the source commit so a later manual merge is possible.

## Result

**Done locally (2026-10-15).** No cloud resource was touched. Everything ran on the local PostgreSQL 18.6 and the stub (demo
mode); no Control API was started for the panel and no Playwright spec ran against a live backend.

- **Source:** `../qelay-control-panel` at its committed `HEAD`, `8ebf9328950a23a2f2687115a0ec15e66b7659bd`, copied with
  `git archive` (reproducible). The upstream working tree had 385 modified and about 25 untracked files beyond that commit;
  none are in this copy. Provenance, what was left out, what changed and every removed suite are in
  [docs/PORTING.md](../../../docs/PORTING.md) ("Panel (task 33)").
- **Licence:** the upstream `LICENSE` already carried `Copyright (c) 2026 Egeo Minotti` and `Copyright (c) 2026 ChxisB`; it is
  unchanged and `test/legacy-name-guard.test.ts` asserts both.
- **Rebrand:** package `@qelay-cloud/panel` (private), document title `Qelay Cloud`, title suffix, assistant prompt, no
  canonical or social-card tags (host unknown). Visual design untouched.
- **Workspace:** `bun install`, `typecheck`, `lint`, `format:check` and `architecture` pass for the whole workspace including
  `packages/panel` (root `typecheck` also runs the panel's three tsconfigs). The four `@ai-sdk/*` adapters are pinned to the
  versions the upstream lock resolved, because the newest ones pulled a second `@ai-sdk/provider` and broke the types.
- **Tests:** upstream 257 files; 193 here (64 suites removed, each of them tests the agent, scripts, docs site or
  release tooling that is not carried). `bun test packages/panel`: 1,066 pass, 0 fail. No suite for `src/` or `shared/`
  was removed or weakened. One suite (`test-inventory-gate`) was first missed and surfaced only in the full `bun test`
  as an unhandled `ENOENT` on `agent/`; it was removed and listed.
- **Features:** queue-operations, backups and fleet are kept and hidden by capability in task 34; flows go to task 51;
  workflows to task 62; `agent/` is removed.
- **Dev run:** `dev:stub` (`VITE_DEMO=1 vite`) boots on :5273 and a headless browser rendered 13 routes with no console
  or page errors. `build` (`tsc --noEmit && vite build`) passes (1.3 MB `dist`).
- **E2E:** the Playwright setup is kept; all 15 specs in 5 files are skipped with `LIVE_BACKEND_PENDING` (they drove the
  removed agent and a live server). Task 34 writes the runtime and removes the skips.

**Not done / owed**

- 120 React-compiler lint findings (`react/refs`, `react/set-state-in-effect`, `react/purity`, `react/immutability`,
  `react/globals`) are **warnings** for `packages/panel/**` only. The upstream lock used an Oxlint without those rules. They
  are listed by `bun run lint`, not hidden; fixing them changes component code and belongs to a later task.
- The panel still calls the upstream agent's `/agent/*` routes, sends no `confirm` or `expectedVersion`, and keeps the
  `VITE_BUNQUEUE_URL` / `VITE_BUNQUEUE_AGENT_URL` names. Footer and command palette still link to the upstream repository
  and docs. All of it is task 34.
- To use the upstream's uncommitted work, commit it there and copy again (D8: later fixes do not flow in on their own).
