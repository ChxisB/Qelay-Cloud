# 04 — Writer rules

**Status:** done · **Depends on:** 03 · **Touches:** packages/store-postgres (writer, plan, retention)

## Goal
The delivery writer applies dedupe and delay; stopping the writer is refused while a route has either; the tick prunes dedupe keys.

## Steps
1. `plan()` takes the delay and the dedupe of a hook and returns the due time; the writer upserts dedupe keys in its transaction and drops the events that were seen.
2. `hasFiltered` counts `delay_ms` and `dedupe`.
3. `pruneWebhookDeliveries` deletes dedupe rows past their window.

## Acceptance
- With a delay, the delivery exists at once and is not claimable until `delayMs` after the event.
- With a dedupe, of two matching events inside the window only the first makes a delivery, in one page and across pages; one after the window makes another.
- A filtered-out event does not start a window.
- A pass that fails and repeats makes the same deliveries (the dedupe write rolls back with it).
- `stopWriter` is refused while a route has a delay or a dedupe.
- Pruning removes only expired keys.

## Verify
```bash
QCLOUD_REQUIRE_DB=1 bun test packages/store-postgres/test/webhook.writer.test.ts packages/store-postgres/test/webhook.rules.test.ts
```

## Risks / notes
Dedupe cost is one batched upsert for a page; limits.md gets the number.

## Result
Writer applies delayMs (next_attempt_at = event time + delay, created_at unchanged) and dedupe (webhookDedupe.ts: windows read, applied in event order and written once per page inside the page transaction; key = sha256 of the chosen fields; filtered-out events open no window). Planned-query row for the window lookup. webhook.rules.writer.test.ts 9 tests (delay not claimable until due, in-page and cross-page dedupe, window expiry, rollback of a failed pass, prune keeps live windows). Local PG 18: webhook*, schema* and maintenance suites 695 pass, 0 fail; typecheck, oxfmt, oxlint clean.
