# Remove "bunqueue" from the project

Date: 2026-10-17 · Requested by the owner. Nothing was pushed, published or version-bumped.

## Why the name was there

Qelay-Cloud ports code from Qelay, which is derived from bunqueue; the panel is a fork of qelay-control-panel, a fork of the
bunqueue dashboard. The ported text, the panel's copy, env/header/MCP names and the licence paragraph kept the old name.
bunqueue is not a dependency or a runtime component.

## What changed

- **Panel (116 files, `packages/panel`)**: "Bunqueue/bunqueue/BUNQUEUE" became "Qelay/qelay/QELAY", and "Bunqueue v2.x" version
  wording was dropped. Renamed with it: `VITE_QELAY_URL`, `VITE_QELAY_AGENT_URL`, the `__QELAY_*__` runtime placeholders
  (`serve/server.ts`, `main.tsx`), the `X-Qelay-Db-Export-*` headers, `QELAY_*` server env names, `qelay-mcp` and `qelay://`
  names, demo fixtures. These name the real Qelay server's interface, so the names are accurate for what the panel talks to.
- **Licence**: the MIT copyright lines (Egeo Minotti 2024, ChxisB 2026) stay, because MIT requires them. The explanatory
  paragraph now names Qelay only. Same text in all 11 package `LICENSE` files.
- **Docs**: `DESIGN.md`, `README.md`, `CHANGELOG.md`, `docs/PORTING.md` (plus a row for the panel rename), `docs/spikes/01-postgres-port.md`,
  panel README, `CURRENT.md`, store DDL comment, control-api shape-file headers.
- **Guards**: `legacy-name-guard.test.ts`, `brand-copy-guard.test.ts`, `brand-assets.test.tsx` and `nav-capabilities.test.tsx`
  still forbid the old name; they build the pattern (`/bun.?queue/i`) so the word is not in the repo.

## Kept on purpose

`scripts/port.ts` (its `replaceAll('bunqueue', 'qcloud')` is functional: `../qelay` sources still contain the word);
`.claude/` history (task files 01, 33, 34 and their completion notes); the `bq*` short file names; the `bq-dash` legacy
localStorage migration; the Egeo Minotti copyright line.

## Mistakes the rename made, and the fixes

The mechanical rename also rewrote the old-name guards into contradictions (`not.toMatch(/qelay/i)` on an SVG titled
Qelay) and collapsed `bunqueue v2.8.55` into `qelay` in five Settings assertions. Found by the panel tests, restored by hand
in `settings-security`, `frontend-a11y-fixes-03`, `brand-assets`, `nav-capabilities`.

## Verified (local, emulators only)

format:check, typecheck, lint (exit 0), architecture, `docs:check`, `notices --check`, `security:routes --check`: pass.
`bun test`: 4,987 pass, 29 skip, 1 todo, 2 fail (the a11y test above, fixed and rerun green; and
`test/gameday/database.test.ts`, 162 connections against >= 163, which passes on its own and was not touched by the rename; it
ran while `docs:check` held database connections, so this is a likely cause, not a proven one). Panel e2e on Chromium and
WebKit: 70 of 70. `test:model`, the scenario suites and `check:terraform` were **not** rerun; the change touches no core,
store or infra code beyond one comment and the LICENSE files.

## Task 73 impact

The task 73 clean-copy verification predates this change. The gate commands above were rerun on the working tree, not a clean copy.

## Open

- The panel's `/mcp` page is not hidden in a Qelay Cloud deployment and now describes Qelay's own MCP server, which Qelay Cloud
  does not have. Hiding it means adding `mcp` to `HIDDEN_FEATURES` (`packages/control-api/src/types.ts`) and a gate in
  `packages/panel/src/lib/capabilities/model.ts`. A product decision, not made here.
