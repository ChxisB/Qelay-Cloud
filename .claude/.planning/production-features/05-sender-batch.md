# 05 — Sender: batch claim, one request, record

**Status:** done · **Depends on:** 04 · **Touches:** packages/store-postgres/src/store/webhookClaim.ts, webhookRecord.ts, packages/maintenance/src/webhook*
**Design:** none (reuses existing pages and parts)

## Goal
A batch route's due deliveries go out as one signed request, and the result is recorded for each.

## Steps
1. Claim: for a batch route take up to `maxEvents` due deliveries (and stop at maxBytes), and count one against the per-minute rate, not one per delivery.
2. Sender: group a batch route's claimed deliveries, build the envelope (core `buildBatchBody`), post once, sign as a single delivery, set `X-Webhook-Event: webhook.batch` and `X-Webhook-Id: <batchId>`.
3. Record: the same outcome for every member, `batch_id` stored on each attempt; one shared retry delay (one jitter draw per batch) so members retry together.
4. A member that cannot be rendered (shape error) is already failed at write time and is not in the batch.

## Acceptance
- 250 due deliveries with maxEvents 100 make three requests (100, 100, 50) and one rate unit each.
- A 5xx makes all members retry at the same time; the retry sends the same batchId when the members are the same.
- A receiver 2xx marks all members delivered; history of each shows the batchId.
- A route without batch sends exactly as before.

## Verify
```bash
QCLOUD_REQUIRE_DB=1 bun test packages/maintenance packages/store-postgres/test --grep webhook
```

## Result
Done. A batch route's due deliveries now go out as one signed request, and the result is recorded for each.

**Changed**
- `store/webhookClaim.ts` (+ new `webhookClaimOrder.ts`): a claim takes up to `maxEvents` due deliveries of a batch route in one lateral (sized by `octet_length` of the shaped body or the stored request), cuts at `maxBytes` (the first always stays), marks them `batched`, and counts the batch as ONE request toward the claim `limit` and the route's per-minute rate. One batch per route per claim.
- `store/webhookRecord.ts`: `batch_id` stored on each delivery, `batchId` in the history entry; members of a batch that retry share one retry time (one jitter draw, at the most attempts any member has used). Streak/pause counting is still per delivery.
- `maintenance/src/webhookBatchSend.ts` (new): `unitsOf` groups a claim into requests, `sendUnit` sends a batch via `sendDelivery(…, batch)` with `X-Webhook-Event: webhook.batch`, `X-Webhook-Id: <batchId>`, `X-Webhook-Attempt` = highest member attempt, signed over the envelope. A member whose payload cannot be made fails alone and is left out of the envelope and the batch id.
- `webhookSender.ts` and `webhookLoop.ts` count requests (units), not deliveries, for the chunk size, the short-claim check and the loop's slots. `webhookConfig.ts` doc for `batch` says requests.

**Tests** (all new, all passing)
- `store-postgres/test/webhook.batch.test.ts` (6): 250 due / maxEvents 100 = 100, 100, 50 with `ratePerMinute: 2` (rate unit one each, rate window then frees the last 50); bytes cut and an oversize event going alone; batch and plain route sharing the claim limit; shared retry time at the latest member's backoff and `batch_id` kept; 2xx history names the batch; a plain route unchanged.
- `maintenance/test/webhook.batch.db.test.ts` (5): one signed POST with the envelope and headers (signature verified with the route's secret); a 503 retries all three at one time and the retry carries the same batch id and attempt 2; plain route beside a batch route; a removed request fails alone while the other two go together; the sender process (`runWebhookLoop`) sends a backlog of 5 as one request.

**Ran** (scratch Postgres 18 on 127.0.0.1:55442, `QCLOUD_REQUIRE_DB=1`): `bun test packages/maintenance packages/store-postgres/test --grep webhook` = 378 pass, 21 skip (PgBouncer/TLS services not running), 0 fail; `bun run typecheck`, `lint` (only the existing panel warnings), `format:check`, `architecture` pass.
**Not run:** PgBouncer-backed suites (`pooled`, `connection.pooler`), `test:model` (no queue semantics changed in this task).
