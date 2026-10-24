# 13 — Queue run window

**Status:** done · **Depends on:** 11 · **Touches:** packages/store-postgres (claim, tick), packages/maintenance, packages/control-api, packages/sdk, test/model
**Design:** none (reuses existing pages and parts)

## Goal
Workers claim from a queue only inside its window (for example 00:00 for four hours, Europe/London); the rest waits.

## Steps
1. Claim: after the paused check, a queue with a window and now outside [window_from, window_until] returns an empty claim. Two integer comparisons, no cron parsing.
2. Tick step: for queues with a window, move the interval so it contains now or is the next one (n = nextFire(cron, now - duration)); when a window opens, ring the queue's waiting jobs.
3. Routes: GET and PUT/DELETE /queues/{queue}/run-window (operator, audited); SDK methods. Running jobs are never interrupted; a retry or delayed job waits for the next opening.
4. Document tick-bound precision for the ring at opening.

## Acceptance
- Outside the window a bell claims nothing and the job stays waiting; inside, it runs.
- A tick that was down through an opening still opens the window when it returns, if now is inside it.
- Pausing a queue still wins over an open window.
- A queue with no window: the claim does the same work as before. test:model passes.

## Verify
```bash
QCLOUD_REQUIRE_DB=1 bun test packages/store-postgres packages/maintenance packages/control-api && bun run test:model
```

## Result
Done. A queue can carry a run window `{cron, durationMs, timezone}`; outside it a claim returns nothing, the tick moves the window on, and no bell is spent on a closed queue.

**What changed**
- `core/queueWindow.ts`: `QueueRunWindow`, `QueueRunWindowInput` (zone optional), `QueueRunWindowState` (`open`, `opensAt`, `closesAt`) and `validateRunWindow` (1 minute to 7 days, the cron rules of the route schedule, field named in `UnsupportedOptionError`). `validateSchedule` and `checkSchedule` take the option name, so a bad cron reads `runWindow`.
- `store-postgres/store/queueWindow.ts`: `intervalFor` (the first window that ends after now), `getRunWindow`, `setRunWindow` (exclusive lock, UPDATE of `run_window`, `window_from`, `window_until`) and `advanceWindows` (the tick step: `FOR UPDATE SKIP LOCKED`, oldest ended first, a bad cron is skipped so one row cannot stop the tick). `store.queues.runWindow()` and `setRunWindow()` in `facets.ts`.
- Claim: after the state lock, `windowClosed(state, now)` returns an empty claim. Two integer comparisons, no cron parsing. A pause is checked after it and still wins.
- Tick: a new timed step `windows` before the ring query.
- Ring query: skips a closed queue exactly as it skips a paused one. Enqueue into a closed queue leaves the job unrung (`unringIfClosed`); `registerQueues` returns the closed set from the same statement that reads the policies, so the enqueue is still 5 statements (`queue.window.test.ts` counts them).
- Deployment health: `windowClosed` on `DoorbellHealth`, the Control API row and `docs/openapi.yaml`. The Deployment view leaves paused queues and closed windows out of `notRung` and the oldest age, so held jobs do not raise the critical `doorbells_overdue` ("maintenance is behind").
- Control API: `GET`, `PUT` and `DELETE /queues/{queue}/run-window` (`PUT` and `DELETE` operator-only, audited as `runWindow <cron> for <ms>ms` / `runWindow removed`); `docs/openapi.yaml`, generated `docs/reference/routes.md` and `docs/security/routes.md`, control-api README, `docs/compat.md` (SDK row), `docs/limits.md` section 1, DESIGN.md D17.
- SDK: `Queue.setRunWindow()` and `Queue.getRunWindow()`, the types exported.

**Deviations from the plan**
- Migration 23 (task 11) is not shipped, so I edited it: the fifth column `window_rung_from` is gone (it would have marked which opening was rung) and a partial index `qcloud_queue_state_window_idx (namespace, window_until) WHERE run_window IS NOT NULL` serves the tick step. A bell rung before the close is old by the opening, so the ring query's stale branch rings it again and no marker is needed. The snapshot is regenerated and `schema.planned.ts` has the row for the new query.
- "Ring the queue's waiting jobs when it opens" is not a separate step: the ring query does it at the first tick after opening (above).
- Overlapping windows (a duration longer than the gap between two fires) close the queue for up to one tick at the end of each interval. Marked with a `shortcut:` comment in `intervalFor`.
- A window saved on a queue is honoured only by processes on this release; an older worker claims at any time. Said on the route, the SDK method and in compat.

**What ran** (local Postgres 18 on 55442, `QCLOUD_REQUIRE_DB=1`):
- `bun test packages/store-postgres packages/maintenance packages/control-api packages/sdk packages/core`: 3576 pass, 23 skip, 2 fail on the first run. Both failures were timing and both pass alone. `worker.batch.test.ts` ("a throw fails every job ... new batch") asserted that three retries reach the handler as one batch, which depends on the tick; it now asserts the first call is attempt 0 and the later calls total three jobs at attempt 1 (5 of 5 runs pass). `lease.heartbeat.test.ts` "a heartbeat racing a release" timed out at 5 s while lint and format ran beside it; it takes 1.9 s alone and passed on three reruns. I did not change it.
- `bun run test:model`: 31 pass.
- New tests: `queue.window.test.ts` (14), `queueRunWindow.test.ts` in control-api (8), `queue.runWindow.test.ts` in the SDK (3), `core/queueWindow.test.ts` (2), a closed-window case in `deployment.test.ts` and in `ops.deployment.test.ts`.
- Typecheck, lint (no errors), `format:check`, `architecture`, `docs:check`, `security:routes`, the openapi suites.

**Not run:** the full `bun test` as one command (the PgBouncer, TLS, Pub/Sub and SQS suites skip), the heartbeat measurement owed from task 08, the panel (task 14). The window's opening precision (up to one tick interval) is documented, not measured.
