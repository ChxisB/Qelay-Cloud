# 04 — Sender: deliver a request's event, body unchanged by default

**Status:** done · **Depends on:** 03 · **Touches:** packages/maintenance, packages/store-postgres, packages/core

## Goal
The tick's sender delivers a request's event: the request's own body when there is no shape, the shaped body when there is one.

## Steps
1. The claim joins `qcloud_requests` for a delivery with a `request_id` and carries the body, the content type and the source id.
2. `webhookSend.ts`: `body` NULL on a request delivery sends the request's bytes with its `Content-Type`; a shaped body sends
   JSON as today. Signing, headers, retry, rate and auto-pause are unchanged. `X-Webhook-Schema` is sent only when the body is
   the old job body.
3. `webhookEnqueue.ts` (a `queue` destination): the job's `data` is the parsed JSON body (or the text for a non-JSON body), its
   name is the delivery's event name, `request.received` (the claim does not carry the route's name), and its id is still
   derived from the delivery id.
4. The destination check (HTTPS, not private) runs on the route's destination only, never on a value from the request.
5. Both sender paths (`webhookSender.ts`, `webhookLoop.ts`) are covered.

## Acceptance
- `{ "id": 500, "name": "chris" }` posted with no shape reaches a stub destination as the same bytes with
  `Content-Type: application/json` (test).
- A shaped route sends the shaped JSON (test).
- A `queue` route adds a job whose data is the request body (test).
- A request carrying a URL in its body cannot change where the delivery goes (test).
- The existing sender suites pass unedited.

## Verify
```bash
QCLOUD_REQUIRE_DB=1 bun test packages/maintenance packages/store-postgres packages/core
```

## Result
Done 2026-10-23.

**Changed**
- `core/webhookCrypto.ts`: `signWebhook` takes `string | Uint8Array`, so a request's bytes are signed as received. `core/webhook.ts`:
  `DeliveredEvent` also allows `request.received`.
- `store-postgres`: the claim carries `requestId`, `requestBody` and `requestContentType` (`webhookClaimRequests.ts` reads the
  stored requests of a claim in one query, and only for deliveries with no shaped body). `inboundRetention.ts` and the retention pass
  delete requests older than `max(webhookKeepMs, 2 x WEBHOOK_DELIVERY_EXPIRY_MS)`, a batch at a time. They only feed `more`, because
  the existing retention tests compare the whole result with `toEqual`. The retention row in `schema.planned.inbound.ts` is now the real statement.
- `maintenance`: `webhookPayload.ts` decides what is sent (shaped JSON, the request's bytes with a content type, the old job document,
  or a refusal in words) and the queue route's job data. `PostRequest` gets `bytes` and `contentType`; `encodeRequest` uses them.
  `webhookSend.ts` and `webhookEnqueue.ts` use `webhookPayload.ts`. Both sender paths share `sendDelivery`, so `webhookSender.ts`
  and `webhookLoop.ts` are covered.
- A content type is copied into a header line only if it is printable ASCII; otherwise `application/octet-stream`. A request
  with no content type is sent as `application/octet-stream`, never called JSON.

**Deviations from the plan**
- The queue job's name is `request.received`, not the route's name or `request`.
- `test/webhookSupport.ts` (the shared `delivery()` helper) got the three new fields set to `null`, which the type needs. No sender
  suite was otherwise edited.

**Tests added:** `webhook.request.test.ts` (9, no database), `webhook.request.db.test.ts` (4, through the tick),
`inbound.retention.test.ts` (2), one core test for signing bytes. Each Acceptance line has one: same bytes and `application/json`
for `{ "id": 500, "name": "chris" }`, a shaped route sends JSON, a queue route's job data is the body, a URL in the body cannot move
the delivery.

**Ran (local Postgres 18 on the scratch host instance, `QCLOUD_REQUIRE_DB=1`)**
- `bun test packages/maintenance packages/store-postgres packages/core`: 2518 pass, 23 skip, 0 fail (the skips are the emulator, PgBouncer and TLS suites).
- Typecheck, lint (no errors), format check and architecture: pass.
- The full `bun test` ran before the last type-only edit (`DeliveredEvent`): 6051 pass, 252 skip, 4 fail. One is the known
  `release.test.ts` per-package LICENSE check. Three were load flakes in the parallel full run (`events.limits`,
  `transport-gcp/stats`, `wfengine/engine`); all three pass when run alone (31 pass). The full suite was not rerun after the type edit.

**Not run:** Docker-backed and emulator suites (Pub/Sub, ElasticMQ, PgBouncer, TLS), real clouds.
