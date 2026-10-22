# V8 — Verify, DESIGN-MAP, README, completion note

**Status:** done · **Depends on:** V1 to V7 · **Touches:** .claude/.planning/console-redesign/DESIGN-MAP.md, packages/panel/README.md, .claude/completions

## Goal
Everything above is checked and written down.

## Steps
1. DESIGN-MAP rows R34 and later for the read-first card, the graph and the teaching empty states.
2. Panel README: one bullet.
3. Headless sweeps at 390 and 1440 wide (clip and route), e2e with axe through the scratch config.
4. Full gate with the scratch Postgres 55442 and `QCLOUD_REQUIRE_DB=1`, under `caffeinate -i`.
5. `.claude/completions/2026-10-20-ui-patterns.md`.

## Acceptance
- typecheck, lint, format check and architecture pass; `bun test` has no new failure beyond the two known (licence line, plan-throughput flake).
- Route sweep has 0 problems, e2e 35 of 35 or the failures are explained.

## Verify
```bash
bun run typecheck && bun run lint && bun run format:check && bun run architecture && bun test
```

## Risks / notes
Firefox and WebKit, a pixel diff and a first-time-user try-out stay unrun.

## Result

**Changed:** DESIGN-MAP rows R34 to R37, one bullet in the panel README, `.claude/completions/2026-10-20-ui-patterns.md`.
Two e2e specs were updated on purpose, not loosened: `flows.e2e.ts` ("a link to a job inside a flow") now checks the marked
node on the Graph (the default view) and then the selected row after pressing List; `webhooks.e2e.ts` reopens "New webhook"
and checks the signing secret field is empty, because the form closes after a create. Two doubled words ("78d ago ago",
"seen 3m ago ago") were fixed in `ExecutionSummary.tsx` and `WorkflowOverview.tsx`: `formatRelativeTime` already says "ago".

**Ran** (scratch Postgres 18 on 127.0.0.1:55442, `QCLOUD_REQUIRE_DB=1`, Chromium only, no real cloud resource):
- Gate: typecheck, lint (116 warnings, 0 errors), format check and architecture clean. `bun test`: 5220 pass, 252 skip, 1 fail
  (`test/docs/release.test.ts:21`, the licence line, known). The plan-throughput flake passed this run.
  The two "ago" edits came after the gate began; typecheck, lint, format check and the workflow panel tests were run again after them.
- e2e with axe: 35 of 35 in one run. The first run of the suite had 2 failures (the two specs above), found by this run, fixed, and
  the whole suite then re-run clean. The new Definition-tab check in `workflows.e2e.ts` passes.
- Headless Chromium, 43 routes at 390 and 1440 wide: no clipped control; the 172 hits are the two sr-only elements as before.
  Looked at the Job flows graph, the workflow Definition tab (running, waiting and compensation-stuck runs), the queue Settings
  cards and Cron at both widths.

**Did not run:** Firefox and WebKit e2e, a pixel diff, a try-out with a first-time user, `bun run test:model` (no queue semantics changed),
any Postgres-backed suite beyond the gate.

**Note for next time:** a scratch Playwright config outside `packages/panel` loads the specs as CommonJS ("does not provide an
export named E2E_APP_URL"); put it in the package (it inherits `"type": "module"`) and delete it after.

