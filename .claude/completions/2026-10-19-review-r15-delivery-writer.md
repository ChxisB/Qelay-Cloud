# R15: delivery writer, filters and shaping (review F7, Outpost)

Date: 2026-10-19. Tracker: `.claude/.planning/review-2026-10-19/CURRENT.md`.

## What changed

- Migration 14 (`schema/ddl/webhookWriter.ts`): `qcloud_webhook_writers`; `filter`, `shape`, `active_from` on `qcloud_webhooks`;
  `body` on `qcloud_deliveries`. Snapshot regenerated, plan rows in `schema.planned.webhook.ts`.
- Core: `webhookFilter.ts` (validate and match; data only, no job payload), `webhookShape.ts` (validate, render, preview; keys
  shortest first then alphabetical), `WEBHOOK_HEADERS.schema`.
- Store: `webhookWriter.ts` (`writeWebhookDeliveries`, `startWebhookWriter`, `stopWebhookWriter`, `webhookWriterState`),
  `webhookPlan.ts`, `journal.ts` (`readEventsOn`), `webhookClaim.ts`, `webhookHistory.ts`, `webhookApi.ts` (`writeDeliveries`,
  `writerState`, `startWriter`, `stopWriter`).
- Maintenance: `webhookWrite.ts` (`writeOnce`), writer pass in `webhookLoop.ts` and the tick's webhook step, `webhookSend.ts`
  sends `body` as stored, `qcloud-tick webhook-writer on|off|status`.
- Control API: `filter` and `shape` on webhook create and in the wire form, `POST /webhooks/preview`; `docs/openapi.yaml`.
- Tests: core filter and shape (32), `webhook.writer.test.ts` (11, real Postgres), `webhook.send`, `webhook.loop`,
  `webhook.write`, `cli.send`, Control API `webhooks.shape.test.ts`, `webhooks.doc.test.ts`, `openapi.webhooks.test.ts`.
- Docs: `docs/webhooks.md`, `operations.md`, `observability.md`, `limits.md`, `reference/configuration.md`, `DESIGN.md`,
  `security/threat-model.md` (A15); `routes.md`, `security/routes.md`, `unsupported.md`, `sdk-exports.md` regenerated.

## Verify (scratch PostgreSQL 18.6, ElasticMQ, Pub/Sub emulator, all required)

- `bun run test:model`: 31 pass. typecheck, lint (panel warnings only), format:check, architecture and `docs:check` clean.
- Full `bun test`: 5146 pass, 29 skip, 1 todo, 2 fail:
  - `test/docs/release.test.ts:21`: root LICENSE lost its Egeo Minotti line in commit 4103cee. Failed before R15; unchanged.
  - `test/gameday/database.test.ts` `connections_high`: environmental. The drill holds 85% of `max_connections` and the scratch
    server had 300; on this busy host a bare `Bun.SQL` pool of 247 opens only about 175 to 210 connections (no repo code in the
    probe). With the scratch server at 200, as in `docker-compose.test.yml`, the file passes (5 of 5).

## Not done / owed

Job `data` and results in filters and shapes (the journal does not carry them). Panel UI for filter, shape and preview. Writer
throughput and lag at volume on a real database (F17), and PostgreSQL 16 and Docker runs. Known flakes seen earlier in this work:
`workflow.sub` under load and the `read.plans.aux` fourteen-day throughput plan.
