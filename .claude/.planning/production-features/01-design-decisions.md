# 01 — Design decisions D15 to D17

**Status:** done · **Depends on:** — · **Touches:** DESIGN.md, docs/unsupported.md (notes only)
**Design:** none (reuses existing pages and parts)

## Goal
Record the three decisions before any code, and mark the Phase 0 closure of DLQ retry as reopened.

## Steps
1. DESIGN.md: D15 send schedule and batch (delivery due time = first fire at or after now + delayMs; batch envelope; http only; one request counts once against the rate; a batch retries as a whole; same members give the same batchId).
2. D16 DLQ retry reopened (version precondition and entry fence; bounded set of 500; retention settable; no auto-retry).
3. D17 queue policy (server-side default attempts and backoff, applied when a job sets none) and run window (cron + duration + time zone; claims return nothing outside it; a running job is not interrupted).
4. Edit the two 'Closed in v1' notes (task 31 and 32) to say what was reopened, and by which decision.

## Acceptance
- D15, D16, D17 are in DESIGN.md with status Decided and the owner's approval date.
- The two closure notes name D16 as the reversal. No other decision text changed.

## Verify
```bash
bun run docs:check
```

## Result
Done 2026-10-23. `DESIGN.md`: rows D15, D16 and D17 in the decisions table (Decided, owner, 2026-10-23); three sections before
`## 7. Cloud specifics` (send schedule and batch, DLQ retry reopened, a queue's policy and run window); the two "Closed in v1"
notes now say DLQ retry and retention were reopened by D16 and that auto-retry stays closed. No other decision text changed.
Choices made while writing, for the owner to see:

- A batch route needs a `schedule` or `delayMs` to gather anything; without one deliveries are due at once and go out alone
  (or in whatever happens to be due in the same tick). Stated in D15.
- A retry after a failed scheduled delivery follows the retry schedule, not the cron.
- A job in a flow cannot be DLQ-retried (`flow_member`); the flow's `retry-failed` is the way.
- The run window opens as late as the tick is (limits.md section 1); a pause beats an open window.

Ran: `bun run docs:check` passed (the documented-commands step skipped, Postgres was not reachable from that process).
