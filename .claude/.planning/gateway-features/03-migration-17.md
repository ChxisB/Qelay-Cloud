# 03 — Migration 17

**Status:** done · **Depends on:** 02 · **Touches:** packages/store-postgres (schema, rows, create/read)

## Goal
Migration 17: `name`, `description`, `delay_ms`, `dedupe` on `qcloud_webhooks` and the `qcloud_webhook_dedupe` table; the store reads and creates them.

## Steps
1. `schema/ddl/webhookRules.ts` and a row in `MIGRATIONS`. Columns are nullable.
2. `WebhookRow`, `WEBHOOK_COLUMNS`, `webhookOf`, `WebhookRecord`, `WebhookSpec`, `validate`, the create INSERT and RETURNING list.
3. Regenerate `schema.snapshot.txt`; add the dedupe prune path to `schema.indexes.test.ts`; update `schema.versions.test.ts` and the planned-objects files.

## Acceptance
- A fresh database and an upgrade from 16 both end at 17 with the same snapshot.
- A webhook created with a name, description, delay and dedupe reads back the same; none of them is required.
- Delay or dedupe on a namespace without the writer is refused like a filter is.
- Migration checksums of 1 to 16 are unchanged.

## Verify
```bash
QCLOUD_REQUIRE_DB=1 bun test packages/store-postgres
```

## Risks / notes
Forward-only: no existing column is touched. Old workers ignore the new columns.

## Result
Migration 17: name, description, delay_ms, dedupe on qcloud_webhooks and qcloud_webhook_dedupe (index on (namespace, until), planned-query row, tick prune in webhookRetention.ts). Validation moved to webhookValidate.ts with needsWriter; create refuses delay/dedupe without the writer; hasFiltered counts them. Snapshot regenerated (additions only). Local PG 18: webhook* and schema* store suites, 269 pass; typecheck, oxfmt, oxlint clean.
