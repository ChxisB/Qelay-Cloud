# 16 — Production settings guide and warnings

**Status:** done · **Depends on:** 14 · **Touches:** docs/production.md, packages/control-api/src/ops (deploymentWarnings), docs/limits.md
**Design:** none (reuses existing pages and parts)

## Goal
One page of recommended settings with why, and warnings in GET /deployment when the setup contradicts them.

## Steps
1. docs/production.md: always-on tick, tick interval, groupCommit and groupComplete for write-heavy queues, retry policy per queue, run window, batch sizes, connection budget, retention. Each with the number and where measured.
2. deploymentWarnings: delayed or scheduled work on a scheduler-only deployment; a route with a schedule and no sender; a queue window with no tick.
3. Link from the README, quickstarts and limits.

## Acceptance
- Each warning has a test; no warning when the setup is fine.
- docs:check passes and every number quotes limits.md or a Result.

## Verify
```bash
bun test packages/control-api --grep deployment && bun run docs:check
```

## Result
Done. `docs/production.md` is the guide, and `GET /deployment` has three new warnings.

- **Guide.** Sections: the tick (always-on `qcloud-tick loop`, `QCLOUD_TICK_INTERVAL_MS`, upkeep, late and stale thresholds), workers and the database (`groupCommit`/`groupComplete`, worker `batch`, the connection budget, throughput), a queue's retry policy, run windows, scheduled and batched sends, retention, and a table of the new warnings. Every number is labelled **measured** (with the `limits.md` section it comes from), **derived** or **chosen**. I checked each quoted figure against `limits.md` and the limits against the code (`queueWindow.ts`, `webhookBatch.ts`, `webhookSchedule.ts`, `MAX_SCHEDULE_GAP_MS`, `WEBHOOK_DELIVERY_EXPIRY_MS`).
- **Warnings** (`packages/control-api/src/ops/warnings.ts`, readings in `deploymentView.ts`): `schedule_without_sender` (enabled routes hold events for a schedule and the tick is `never` or `stale`), `window_without_tick` (a queue with pending jobs is outside its window and the tick is not running), `delay_finer_than_tick` (an enabled route delays by less than the declared tick period; says nothing until `QCLOUD_TICK_INTERVAL_MS` is set). The Control API now reads `QCLOUD_TICK_INTERVAL_MS` (`DeploymentSettings.tickIntervalMs`, resolved to `null` when unset, refused when not positive). Each warning has a test that names it and a test that it is absent when the setup is fine (`ops.warnings.test.ts`, `ops.deployment.test.ts`, `config.test.ts`).
- **Links** from the README, the four quickstarts and `docs/limits.md`; `docs/reference/configuration.md` says the API reads the tick interval.
- **Deviations.** The plan's "delayed or scheduled work on a scheduler-only deployment" is `delay_finer_than_tick`, which needs the declared interval rather than guessing the hosting mode from a tick that is running. A fourth warning was not added for a cron period shorter than the tick interval.

Ran, against local Postgres 18 (127.0.0.1:55442): `bun test packages/control-api --grep deployment` 74 pass; `bun test packages/control-api` 760 pass, 0 fail; `bun run docs:check` passes (688 links, 7 documented blocks run); `bun run typecheck`, `bun run lint` (0 errors), `bun run format:check`, `bun run architecture` pass. Two type errors in the new deployment tests (an unknown `signed` field and the `only` helper's type) and `config.test.ts` at 301 lines were fixed before this.

Not covered: a sender switched off by `QCLOUD_WEBHOOK_BATCH=0` cannot be seen by the Control API (it cannot read the tick's environment), so `schedule_without_sender` is inferred from a tick that is not running; closed windows are counted only for queues with pending jobs (the scan reads no others); the cron period of a schedule is not compared with the tick interval, only `delayMs`; the guide's `chosen` values (batch size 100, the sample retry policy) have no run behind them.
