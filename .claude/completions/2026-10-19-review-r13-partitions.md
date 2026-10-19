# R13: webhook deliveries by day, and a retention setting (review F2)

Date: 2026-10-19. Tracker: `.claude/.planning/review-2026-10-19/CURRENT.md`.

## What changed

- `packages/store-postgres/src/schema/ddl/deliveryPartitions.ts` (new), registered as migration 13: `qcloud_deliveries`
  partitioned by day, a default partition, `qcloud_ensure_delivery_partitions`, `qcloud_drop_delivery_partitions`, the trigger
  rewritten to the new table, live rows moved from `qcloud_webhook_deliveries`, the id sequence continued.
- Store SQL (`webhookClaim`, `webhookRecord`, `webhooks`, `webhookRetention`) reads and writes `qcloud_deliveries`;
  `pruneWebhookDeliveries` makes and drops partitions, then expires and deletes (default partition only).
- `webhookKeepMs` (`settings.ts`, `context.ts`; `DEFAULT_WEBHOOK_KEEP_MS` = 2 days replaces `WEBHOOK_DELIVERY_KEEP_MS`),
  `QCLOUD_WEBHOOK_KEEP_MS` (`webhookEnv.ts`, `maintenance/src/cli.ts`).
- Tests: `webhook.partitions.test.ts` (new), `webhook.retention.test.ts`, plan tests (`schema.indexes.test.ts`,
  `schema.planned.webhook.ts`), `test/support/schemaSnapshot.ts` (skips dated partitions), `schema.snapshot.txt` regenerated.
- Docs: `docs/webhooks.md`, `docs/openapi.yaml`, `docs/reference/configuration.md`, `docs/limits.md`, `docs/known-issues.md`,
  `docs/operations.md` ("Rolling back past version 13"), `DESIGN.md`.

## Verify (scratch PostgreSQL 18.6, `QCLOUD_REQUIRE_DB=1`)

- `bun test ./packages/store-postgres ./packages/maintenance ./packages/control-api`: 2,669 pass, 23 skip (TLS, PgBouncer), 0 fail.
- `bun run test:model`: 31 pass. `bun run docs:check`: ok. typecheck, lint (panel warnings only), format and architecture clean.
- `packages/sdk`, `core`, `test/docs`: 382 pass, 2 fail: `release.test.ts` (the root LICENSE lost the upstream line in 4103cee, not
  from this task) and `workflow.sub.test.ts` "a failing child fails the parent" (passed 3 of 3 alone: a timing flake under load).

## Not done / owed

PG16 and Docker runs. Partition DDL on Cloud SQL and RDS (D9, F17). The drop of the old table (next release). Events are not
partitioned, by design (docs/limits.md). The keep default of 2 days is the owner's to confirm.
