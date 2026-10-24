# 03 — Migration 22: route schedule and batch

**Status:** done · **Depends on:** 02 · **Touches:** packages/store-postgres/src/schema, schema.snapshot.txt, schema.indexes.test.ts
**Design:** none (reuses existing pages and parts)

## Goal
Add the columns, forward-only and safe with old workers connected.

## Steps
1. New migration version 22: `qcloud_webhooks` gets nullable `schedule_cron`, `schedule_timezone`, `batch_max_events`, `batch_max_bytes`; `qcloud_deliveries` gets nullable `batch_id`. CHECKs match the core bounds. `pg_advisory_xact_lock` only.
2. Regenerate the schema snapshot (QCLOUD_UPDATE_SNAPSHOT=1) and review its diff.
3. A row in schema.indexes.test.ts only if a new query path needs an index.

## Acceptance
- Migrating a v21 schema to v22 works with no data change; an old worker still reads and writes routes and deliveries.
- The snapshot test passes with the reviewed snapshot.
- No existing migration file is edited.

## Verify
```bash
QCLOUD_REQUIRE_DB=1 bun test packages/store-postgres/test/schema packages/store-postgres/test/migrat
```

## Result
Done 2026-10-23. Migration 22 `route schedule and batch` (`src/schema/ddl/webhookScheduleBatch.ts`, registered in `migrations.ts`):
`qcloud_webhooks.schedule_cron/schedule_timezone` (both or neither, lengths 1..200 and 1..64), `batch_max_events` (1..500) and
`batch_max_bytes` (1024..1048576) (both or neither, `http` routes only); `qcloud_deliveries.batch_id TEXT`, added on the partitioned parent
so the default partition and the day partitions the tick makes later (they are `LIKE` copies) have it. All nullable, no default, no index
(nothing looks a delivery up by `batch_id`), so no row in `schema.indexes.test.ts`. No migration file edited. Not rolling-safe in one way, as
D15 says: an older tick ignores the two route settings.

New `test/schema.migrate.schedule.test.ts` (4 tests): v21 to v22 with data kept and checksums stable, the release before still inserting,
each CHECK refusing with SQLSTATE 23514 (so a misspelt column cannot pass for a constraint), a queue route refusing a batch and accepting a
schedule, and every partition carrying `batch_id`. The first draft of the test passed for the wrong reason (it named the dropped `events`
column and "failed" every insert); the check now asserts 23514.

Snapshot regenerated (`QCLOUD_UPDATE_SNAPSHOT=1`) and reviewed: the only lines new since migration 21 are `batch_id` (two tables), the four route
columns and the five route constraints. (Against HEAD the file also shows migrations 20 and 21, which are uncommitted.)

Ran on local PG 18: `packages/store-postgres/test/schema` 183 pass; control-api `health.schema`, `runtime.database`, `ops.deployment` and
`test/gameday/migration` 38 pass; typecheck, lint (0 errors) and format clean. Docs that quote "version 21" are for task 17.
