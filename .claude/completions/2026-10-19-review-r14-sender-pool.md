# R14: webhook sender pool (review F6)

Date: 2026-10-19. Tracker: `.claude/.planning/review-2026-10-19/CURRENT.md`.

## What changed

- `packages/maintenance/src/webhookLoop.ts` (new): `runWebhookLoop` (pipelined claim, send, batched record; drains and records on
  stop; store errors go to telemetry and the loop looks again after `idleMs`) and `pooledSending(config)`.
- `webhookPool.ts` (new): `createSocketPool`, keep-alive sockets keyed by address, port, TLS name and CA; `postOverSocket` is a
  pool with keep-alive off. `webhookHttp.ts` is now the wire side only (`encodeRequest`, `readStatus`, `readFraming`).
- `webhookDestinations.ts` (new): per host and port concurrency and a circuit breaker with a half-open probe.
- `webhookSend.ts`: `cachedResolver`, `SendDeps.destinations`; `webhookSender.ts`: `sendDepsOf`; `webhookConfig.ts`: six options
  and `DEFAULT_WEBHOOK_*` constants; `cli.ts`: the `send` command (`openSenderStore`, `options.openStore`); `index.ts` exports.
- Tests: `webhook.pool`, `webhook.destinations` (also `cachedResolver` and sending through destinations), `webhook.loop`,
  `webhook.loop.db` (real Postgres and sockets), `cli.send`, `webhook.config`, `test/docs/webhooks.doc.test.ts`.
- Docs: `docs/webhooks.md`, `docs/reference/configuration.md`, `docs/limits.md`, `docs/security/review-v1.0.0.md`,
  `docs/security/threat-model.md`.

## Verify (scratch PostgreSQL 18.6, `QCLOUD_REQUIRE_DB=1`)

- `bun test ./packages/maintenance`: all pass except the PgBouncer suite, which skips. typecheck, lint (panel warnings only),
  format:check, architecture and `docs:check` clean. `test/docs`: only the old `release.test.ts` LICENSE failure.
- No store change, so no model run and no new plan row.

## Not done / owed

A real receiver (keep-alive, DNS) and throughput at volume: the docs give design figures only. Autoscale on backlog, a
Terraform sender service (R19). A health endpoint for `send`.
