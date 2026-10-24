# 06 — Control API and openapi: route fields

**Status:** done · **Depends on:** 05 · **Touches:** packages/control-api, docs/openapi.yaml, docs/reference/routes.md, docs/security/routes.md
**Design:** none (reuses existing pages and parts)

## Goal
Create and PATCH of a webhook take `schedule` and `batch`; reads return them; deliveries show `batchId`.

## Steps
1. Body validation in the webhook module; errors name the field.
2. openapi: fields on the existing routes; the openapi test and `security:routes` stay green.
3. Audit rows are unchanged (never a payload).

## Acceptance
- POST /webhooks with schedule and batch answers 201 and the read returns them; a bad cron is 400 naming `schedule`.
- PATCH changes or clears them (null).
- docs/openapi.yaml matches the served routes (the openapi test).

## Verify
```bash
QCLOUD_REQUIRE_DB=1 bun test packages/control-api --grep webhook && bun run security:routes
```

## Result
Done. `POST /webhooks` and `PATCH /webhooks/:id` take `schedule {cron, timezone}` and `batch {maxEvents, maxBytes}` (null clears on PATCH);
reads (`GET /webhooks`, `GET /webhooks/:id`, create, edit) return both; deliveries (`WebhookDelivery`) carry `batchId` (null when sent alone)
and a history entry (`WebhookAttempt`) has an optional `batchId`. The store names the fault: a bad cron, a zone that does not exist, a cron that
never fires or fires less than monthly, an unknown key, a batch out of range, or a batch on a `queue` route is 400 `unsupported_option` naming
`schedule` or `batch`.

Changes:
- `packages/control-api/src/jobs/webhookModel.ts`: `schedule` and `batch` in the body rules and the wire.
- `packages/control-api/src/jobs/deliveryWire.ts` (new): `DeliveryWire` and `toDeliveryWire` moved out of `webhookModel.ts` (it passed 300 lines), now with `batchId`.
- `packages/control-api/src/routes/webhooks.ts`: the create spec is the body without its nulls (`withoutNullish`), so a new field needs no line here.
- `docs/openapi.yaml`: `WebhookSchedule` and `WebhookBatch` schemas; fields on `Webhook`, `WebhookCreate`, `WebhookPatch`; `batchId` on `WebhookDelivery` and `WebhookAttempt`; prose of create and edit.
- Tests: `packages/control-api/test/webhooks.schedule.test.ts` (5, new); `openapi.webhooks.test.ts` field lists updated.

Ran (Postgres 18 on 127.0.0.1:55442, `QCLOUD_REQUIRE_DB=1`): `bun test packages/control-api` 728 pass / 0 fail; `bun run security:routes` (no new route, table unchanged);
`bun run typecheck`, `bun run lint` (only the existing panel warnings), `bun run format:check`, `bun run architecture`, `bun run docs:check`.
Added with task 07: a `Webhook` read also returns `nextSendAt` (epoch ms of the next fire at or after the server's clock, null without a schedule),
because the panel has no cron parser or zone data. `nextFire` is exported from `packages/store-postgres`; `docs/openapi.yaml` and
`webhooks.schedule.test.ts` carry it. Rerun with it in place: `bun test packages/control-api` 728 pass / 0 fail, `bun run security:routes`, `bun run docs:check`,
`bun run typecheck`, all clean.
Not run then: the panel (done in task 07); `docs/reference/routes.md` and `docs/security/routes.md` needed no change (no route added or re-gated).
