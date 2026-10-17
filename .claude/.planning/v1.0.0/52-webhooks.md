# 52 — Webhooks

**Status:** done · **Depends on:** 32, 20 · **Phase:** 4

## Goal

Outbound webhooks for job events, matching what the panel's Webhooks page manages, delivered reliably through the same tick and Postgres machinery rather than a new moving part.

## Scope

In: webhook storage, delivery with retries, signing, the Control API endpoints and the panel page wiring.
Out: inbound webhooks, third-party integrations (Slack and similar).

## Reference

Panel: `src/pages/control/Webhooks*` and its API calls.
Upstream: `../qelay/src/application/webhookManager.ts` (delivery and retry behaviour), `../qelay/src/shared/webhookValidation.ts` (URL rules; compare against the SSRF requirements below and keep the stricter of the two).

## Steps

1. **Schema** (new migration): `qcloud_webhooks` (id, url, event types, queues filter, secret reference, enabled, created by) and `qcloud_webhook_deliveries` (id, webhook, event id, attempts, next attempt, status, last status code, truncated last error).
2. **Delivery:** the tick (task 20 gains a step) claims due deliveries with `SKIP LOCKED`, POSTs with a timeout, treats 2xx as success, applies exponential backoff for failures up to a maximum attempt count, then marks the delivery failed. Deliveries are created transactionally from events matching enabled webhooks, so none is lost or doubled.
3. **Signing:** HMAC-SHA256 over the timestamp and body, sent in headers, with a replay window documented for receivers. The secret is stored encrypted or by reference to the cloud secret manager; it is never returned by the API after creation.
4. **SSRF protection:** reject URLs that resolve to loopback, link-local, private or metadata addresses (including after redirects and DNS rebinding: resolve, then connect to the checked address); only `https` outside dev mode; a per-webhook rate limit; a response body size cap.
5. **Endpoints:** CRUD with `operator` role, a "send test event" action, delivery history, retry of a failed delivery. Audit every mutation.
6. **Panel:** wire the existing Webhooks page; show delivery status and last error; no secret display.
7. **Capability:** `features.webhooks`.
8. **Tests:** at-least-once delivery with a flaky receiver; backoff schedule; signature verification vector; SSRF matrix (IPv4/IPv6, redirects, DNS rebinding, decimal and hex IP forms, `localhost` variants); four concurrent ticks never deliver the same attempt twice.

## Acceptance

- A receiver that fails twice and then succeeds gets exactly one successful delivery and the right attempt history.
- The SSRF test matrix is fully blocked, including the redirect and rebinding cases.
- The API never returns a webhook secret after creation.
- Concurrent ticks do not double-deliver an attempt.

## Verify

```bash
bun run typecheck && bun run lint && bun run format:check && bun run architecture
bun test packages/maintenance packages/control-api --grep webhook
```

## Risks / notes

- Outbound requests from a service inside your VPC to user-supplied URLs are a classic SSRF path. The checks above are the minimum; get this reviewed in task 72.
- If webhooks end up needing more than this (fan-out, large volumes), they belong in a separate delivery queue run by the SDK itself. Do not grow the tick for that.

## Result

**Done locally. Nothing was applied and no real cloud was contacted.** Job events are delivered to registered webhooks from the tick,
signed, with retries, and operated through the Control API and the panel. Every Acceptance line is true; what ran is under "Run" and what
did not under "Not run". The operator and receiver documentation is [docs/webhooks.md](../../../docs/webhooks.md) (its example is run, and
its figures are compared with the code, by `test/docs/webhooks.doc.test.ts`). Design decisions are in the task 52 amendment to
[docs/spikes/06-phase0-gate.md](../../../docs/spikes/06-phase0-gate.md).

**Built**

- **Store** (`packages/store-postgres`): migration 8 `'webhooks'` adds `qcloud_webhooks` and `qcloud_webhook_deliveries` and a trigger on
  `qcloud_events` that inserts one delivery per matching enabled webhook in the job's own transaction, so none is lost or doubled. The tick
  claims due deliveries with `SKIP LOCKED` (`webhookClaim.ts`), records outcomes fenced on the attempt number and `status = 'sending'`
  (`webhookRecord.ts`), and keeps finished rows for 7 days (`webhookRetention.ts`). The secret is sealed with AES-256-GCM under
  `QCLOUD_WEBHOOK_KEY` and is never read back by any API.
- **Core** (`packages/core`): the event and policy types, the signature (`X-Webhook-Signature: v1=hex(HMAC-SHA256(secret, "<ts>.<body>"))`,
  300 s replay window), the secret box, and the URL and address policy (`webhookUrl.ts`).
- **Sender** (`packages/maintenance`): a step of `runTick` after the ring (`webhookSender.ts`, `webhookSend.ts`, `webhookHttp.ts`). It
  resolves the name once, refuses unless every answer is public, connects to the checked address with TLS verified against the name, reads
  only the status line, and follows no redirect. `QCLOUD_WEBHOOK_BATCH=0` turns sending off.
- **Control API:** `GET /webhooks`, `GET /webhooks/:id`, `POST /webhooks`, `PUT /webhooks/:id/enabled`, `DELETE /webhooks/:id`,
  `POST /webhooks/:id/test`, `GET /webhooks/:id/deliveries`, `POST /webhooks/:id/deliveries/:deliveryId/retry`. Writes need `operator`, every mutation is one audit
  row (`webhook=<id>` only), `features.webhooks` is derived from the jobs routes, and `docs/openapi.yaml` and a test keep the routes equal.
- **Panel:** the Webhooks page is a Control API client: add (with a one-time generated secret), enable, disable, delete, send a test event,
  delivery history with status, attempts and last error, status filter, retry. A viewer sees only the URL's origin.

**Acceptance**

- *Fail twice then succeed:* `webhook.sender.test.ts` ends with one delivery, three attempts (500, 503, 200), the documented waits
  (1 s then 2 s in the test policy; 30 s then 1 m by default) and one success counted.
- *The SSRF matrix is fully blocked:* `webhook.ssrf.test.ts` and `webhookUrl.test.ts` (IPv4 in decimal, octal, hex, short and fullwidth spellings; IPv6 in
  compressed, long, IPv4-mapped, NAT64 and 6to4 forms; `localhost` variants; the metadata names and addresses; every private, shared and
  special-use range; credentials in the URL), a redirect to the metadata address that is never
  contacted, and a resolver that answers public then private (refused) or changes between the check and the connection (the request still
  goes to the checked address). `https` only outside `QCLOUD_WEBHOOK_DEV_MODE`.
- *The API never returns the secret:* no response of the create, read, list, test, history and enable routes (for an operator and for a viewer)
  carries the secret string or the word "secret", including the answer to the create that supplied it, and an audit test shows that no
  audit row carries an address or a secret.
- *Concurrent ticks:* four ticks over one backlog send each attempt exactly once (`webhook.concurrent.test.ts` in both packages), and a late
  outcome after a lease lapsed is dropped, so the newer attempt stands.

**Measured** (PG 18.6, one machine; `docs/limits.md` section 12)

- The trigger costs about **1.1x** on claim and complete (1.10x and 1.09x in two runs) and **1.6x to 1.8x** on enqueue (1.61x and 1.83x) with
  three webhooks watching a queue (nine delivery rows per job, 8 claimers, 2,000 jobs). The figures are printed by `webhook.cost.test.ts`,
  not asserted, and the enqueue ratio moves from run to run.
- The default retry waits are 30 s, 1 m, 2 m, 4 m, 8 m, 16 m and 32 m: **63.5 minutes** over 8 attempts.

**Run** (PG 18.6, Pub/Sub emulator, ElasticMQ 1.7.1)

- `bun run typecheck`, `bun run lint` (no errors; the repo's `react(...)` warnings remain), `bun run format:check` and `bun run architecture`
  are clean.
- The Verify command `bun test packages/maintenance packages/control-api --grep webhook`: 173 pass, 1 skip (PgBouncer), 0 fail.
- Store suites: 57 webhook tests. Control API: 601 pass in the package. Panel: 1,352 pass from the repo root. Panel e2e on Chromium and
  WebKit: 58 of 58.
- `bun test` with `QCLOUD_REQUIRE_DB=1`, `QCLOUD_REQUIRE_PUBSUB=1` and `QCLOUD_REQUIRE_SQS=1`: 4,560 pass, 29 skip (the PgBouncer and TLS
  suites, which need Docker), 1 todo, 0 fail; 4,590 tests in 457 files, 886.23 s.

**Not run**

- The Docker-backed gate (PG 16 DDL snapshot and EXPLAIN for migration 8 and the delivery claim, PgBouncer, TLS) and `bun run test:model`
  under every compose profile: owed to the end of the plan, as agreed.
- Firefox e2e: it cannot launch in this sandbox. A receiver across the internet, a public CA's certificate chain, and the egress of a real
  VPC (whether the metadata address and internal names are in fact unreachable from the tick): D9.
- **An independent review of the SSRF defences is owed in task 72.** The matrix above is what the author could think of.

**Found and fixed**

- `Bun.SQL`'s `tx.array(values, type)` throws on a null element for BIGINT and INTEGER and writes the text "null" for TEXT without an error.
  The webhook queries pass rows as `jsonb_to_recordset(${JSON.stringify(rows)}::text::jsonb)`. Other code was not swept for this.
- A comment and a test title said the retry budget was "about four hours". It is 63.5 minutes; both are corrected.
- A controlled input with `onChange` did not update React state under the panel test helpers while `onInput` did; the secret field uses
  `onInput`, as the URL field does.
- The doc test first ran the documented example through the `Function` constructor, which the linter refuses; it loads the block as a
  module instead.

**Decisions** (details in the spike amendment)

- One queue per webhook (a filter column), not a list of queues: a deliberate narrowing of the task's "queues filter".
- Unsigned webhooks are allowed and flagged (`signed`). The body carries no job data. No ordering guarantee.
- Registration validates the URL string and never resolves the name; the send-time check is the defence.
- The sender is a tick step at operator scale; fan-out belongs in a separate SDK-run queue.

**Owed / for the final message:** see the Owed list in [the completion doc](../../completions/2026-10-15-52-webhooks.md).
