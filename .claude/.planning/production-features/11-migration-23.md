# 11 — Migration 23: queue policy and run window

**Status:** done · **Depends on:** 01 · **Touches:** packages/store-postgres/src/schema, schema.snapshot.txt
**Design:** none (reuses existing pages and parts)

## Goal
Columns for a queue's default retry policy and run window, forward-only.

## Steps
1. `qcloud_queue_state` gets nullable `policy` jsonb ({ attempts, backoff, timeout }), `run_window` jsonb ({ cron, durationMs, timezone }), `window_from` and `window_until` bigint.
2. Snapshot regenerated and reviewed; advisory lock only.

## Acceptance
- v22 to v23 migrates with data; old workers still claim (they ignore the columns).
- Snapshot test passes.

## Verify
```bash
QCLOUD_REQUIRE_DB=1 bun test packages/store-postgres/test/schema
```

## Result
Migration 23 `queue policy and run window` (`packages/store-postgres/src/schema/ddl/queuePolicyWindow.ts`, registered in
`migrations.ts`). It adds to `qcloud_queue_state`, all nullable, nothing existing changed:

- `policy` jsonb, `run_window` jsonb (each checked to be an object, nothing more: the fields are checked by the Control API
  and the store when saved, the cron by the store's parser).
- `window_from`, `window_until` bigint: the window as one interval, the one that contains now or the next to come.
  `qcloud_queue_state_window_check`: `run_window`, `window_from` and `window_until` are all set or all null, and
  `window_until > window_from`.
- One partial index, `qcloud_queue_state_window_idx (namespace, window_until) WHERE run_window IS NOT NULL`, added in task
  13 (migration 23 had not shipped): the tick finds the windows that ended without reading every queue, and it has a row in
  `schema.indexes.test.ts`. A fifth column, `window_rung_from`, that this task first added was dropped again in task 13: the
  tick's ring query skips a closed queue, so the bells its jobs had are old when it opens and the re-ring finds them, and
  nothing needs to mark an opening.

Old workers: they name none of the new columns, so every insert and update they run still works (the test runs both
against a v23 database). They also ignore a window: a release before 23 claims from a queue whose window is closed. The
DDL comment says to set a window only after every process runs this release. Task 17 repeats that in the operations guide.

`test/schema.migrate.queuePolicy.test.ts` (2 tests): v22 to v23 with queue rows, drift-free rerun, an old-release
insert and update; the stored policy and window; every CHECK ends in 23514 (not an object, window without interval,
interval without window, one end, empty and backwards interval). `schema.migrate.schedule.test.ts` now migrates to
`upTo(22)` instead of "latest" so it does not move with each new version.

`test/schema.snapshot.txt` regenerated (`QCLOUD_UPDATE_SNAPSHOT=1`) and reviewed. The diff also carries the tables from
versions 20 to 22 (sources, requests, route schedule and batch, the removed job-event trigger) because the snapshot was
not regenerated since they were written. Their lines are what those versions' DDL creates and nothing else; the
version 23 lines are the five columns and three CHECKs on `qcloud_queue_state`.

Ran on scratch Postgres 18 (127.0.0.1:55442, `QCLOUD_REQUIRE_DB=1`): `packages/store-postgres/test/schema` 186 pass;
`packages/store-postgres` 1866 pass, 22 skip, 0 fail; typecheck, lint, format:check, architecture ok.
Not run: PgBouncer and TLS connection suites (skipped, no service up).
