# R16: auto-disable, alerts, response capture, always-sign (review F15, F21, Outpost)

Date: 2026-10-19. Tracker: `.claude/.planning/review-2026-10-19/CURRENT.md`.

## What changed

- Response capture (step A): a failed attempt keeps the first `WEBHOOK_RESPONSE_CHARS` (1 KB) of the receiver's answer as text,
  `User-Agent` on every request (`DEFAULT_USER_AGENT`, overridable). `webhookHttp.ts` (`readBody`), `webhookPool.ts`.
- Migration 15 (`schema/ddl/webhookPause.ts`): `consecutive_failures`, `alert_level`, `disabled_reason`, `disabled_at`,
  `secret_previous_sealed`, `secret_previous_until` on `qcloud_webhooks`; the delivery trigger now also fires for a paused
  webhook (`enabled OR disabled_reason IS NOT NULL`). Snapshot regenerated and reviewed.
- Core: `DeliveryPolicy.disableAfter` (default 20, 0 off), `webhookAlertLevel` (0 to 4 at 50/70/90/100 %),
  `WEBHOOK_SECRET_GRACE_MS` (24 h), `generateWebhookSecret()`.
- Store: `webhookRecord.ts` counts the failed-delivery streak and pauses on the final streak of a batch; `webhookSecret.ts`
  (`rotateSecret`); `webhooks.ts` (always-sign: a store with a `webhookKey` generates `whsec_` plus 64 hex and returns it once as
  `WebhookIssued.secret`; `setEnabled(true)` clears the pause); `webhookClaim.ts` opens the previous secret while it is in
  its window; `webhookWriter.ts` and the trigger keep making deliveries for a paused webhook (held, expire after 24 h);
  `webhookRetention.ts` clears expired previous secrets.
- Maintenance: the sender signs with both secrets (comma-separated `v1=`), `webhooks.paused` gauge and report field,
  `QCLOUD_WEBHOOK_DISABLE_AFTER`.
- Control API: `POST /webhooks/{id}/rotate-secret`; create and rotate return `data.secret` only when generated; wire fields
  `consecutiveFailures`, `alertLevel`, `disabledReason`, `disabledAt`, `previousSecretUntil`; ops warnings `webhook_failing`
  and `webhook_paused`. `docs/openapi.yaml`, `routes.md`, `security/routes.md` regenerated.
- Tests: `webhook.pause.test.ts` (5), `webhook.rotation.test.ts` (3), `webhooks.rotate.test.ts` (3), core unit tests for the alert
  level, `disableAfter` validation and the generated secret; changed `webhook.send` (two signatures), `ops.warnings`,
  `webhook.receiver` (a keyed store signs a webhook with no secret) and the registry, claim, record, sender, loop and API tests
  that assumed unsigned by default.
- Docs: `webhooks.md` (pause, rotation, verify note, config row), `known-issues.md`, `limits.md`, `observability.md`,
  `operations.md` (rolling back past 15), `DESIGN.md`, `security/threat-model.md` (A9), `security/review-v1.0.0.md`.

## Verify (scratch PostgreSQL 18.6, ElasticMQ, Pub/Sub emulator, all required)

- typecheck, lint (panel warnings only), format:check, architecture (300-line cap) and `docs:check` clean.
- control-api, maintenance and core packages: 1209 pass after the receiver test fix.
- Full `bun test`: see the tracker's R16 Results.

## Not done / owed

A panel UI for rotation and for showing a generated secret. Email or pager alerts (the signal is the wire fields, the ops
warnings and the gauge), and a `webhook.disabled` journal event. Real-receiver behaviour, and PostgreSQL 16 and Docker runs.
Existing unsigned webhooks stay unsigned until rotated. Default-on `disableAfter=20`, default-on response capture and
always-sign are decisions for the owner.
