# 04 — Store: schedule and batch fields, due time

**Status:** done · **Depends on:** 03 · **Touches:** packages/store-postgres/src/store (webhook*, inboundFanOut)
**Design:** none (reuses existing pages and parts)

## Goal
A route can be saved with a schedule and a batch, and a delivery made for it is due at the schedule's next fire.

## Steps
1. Read the 24-hour delivery expiry first (webhooks.md): a delivery waiting for a nightly fire must not expire. Decide from the code whether the expiry counts from created_at or next_attempt_at, and fix the rule in this task if it counts from creation.
2. Create and update accept `schedule` and `batch`; the cron is validated with the store's parser (`getNextCronRun`), a schedule that never fires is refused, and `batch` on a queue route is refused.
3. `inboundFanOut.ts`: `a = nextFire(cron, now + delayMs, timezone)` when the route has a schedule.
4. Rows and types carry the fields; the route read returns them.

## Acceptance
- A delivery for a route with schedule '0 0 * * *' in Europe/London is due at the next London midnight (a DST-change test).
- A route without a schedule is made exactly as before (an existing test proves it).
- A delivery waiting up to 25 hours for a fire is not expired.
- Saving batch on a queue route answers a refusal naming `batch`.

## Verify
```bash
QCLOUD_REQUIRE_DB=1 bun test packages/store-postgres/test --grep webhook
```

## Result
Built `store/webhookSchedule.ts` (`nextFire`, `checkSchedule`, `MAX_SCHEDULE_GAP_MS`), `schedule` and `batch` on `WebhookSpec`,
`WebhookPatch` and `WebhookRecord`, the four columns in `webhookRows`/`createWebhook`/`updateWebhook`, `checkedSchedule` in
`webhookValidate.ts`, and `dueAt` in `inboundFanOut.ts` (delay first, then the first fire at or after it). A batch is checked
against the route's destination: at create from the spec, at update inside the transaction against the stored route.

Findings:
- The 24 h delivery expiry counts from `next_attempt_at` (24 h past due), so no change to `webhookRetention.ts` was needed. The
  test holds a delivery 36 h (due after 40 h) through `prune` and claims it at the fire.
- An unreadable or never-firing schedule at fan-out time falls back to "due at once" rather than failing the request accept.
  Saving such a route is refused, so only a zone database that dropped a name can get there.
- DESIGN.md D15 now states the 31-day rule and both of the above.

Ran, on the scratch Postgres 18 (127.0.0.1:55442), `QCLOUD_REQUIRE_DB=1`: `packages/store-postgres/test/webhook.schedule.test.ts`
(9 new tests), and `--grep "webhook|inbound|schema"` over the package: 382 pass, 20 skip (PgBouncer and TLS not running), 0 fail.
`bun run typecheck` and `bun run format:check` clean; `bun run lint` shows only the existing panel warnings.
Not run: the full gate (done at the end, task 17).
