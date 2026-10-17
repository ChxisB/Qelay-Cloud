# 20 — Maintenance tick

**Status:** done · **Depends on:** 15, 16 · **Phase:** 1

## Goal

The repair-and-schedule loop that makes the system correct under failure: cron, due-job ringing, overdue-doorbell re-ring, lease recovery, expiry, retention. One idempotent function, several ways to run it.

## Scope

In: `runTick`, its entrypoints (HTTP, CLI, optional in-process loop), bounded execution, tests.
Out: Terraform for the scheduler (task 21, 42); webhook delivery (task 52 adds a step).

## Gate decisions (task 06)

Binding. Evidence: [docs/spikes/06-phase0-gate.md](../../../docs/spikes/06-phase0-gate.md) ("The tick contract"),
[spike 05](../../../docs/spikes/05-db-access-and-delay.md). This task owns the contract; DESIGN.md section 3 states it.

- **Re-ring rule.** Ring every claimable job in an unpaused queue whose last bell is at least `reRingAfterMs` old.
  `reRingAfterMs` must not exceed the tick interval; validate it when the tick is configured. The age threshold, not
  the `rung_at` null check, bounds invariant 3, because bells are fungible and `rung_at` counts bells.
- **Bounds.** A per-queue cap per tick (a backlog must not become one bell per waiting job every tick) and a grace for
  a job with no `rung_at` yet (its publish may be in flight). Both come from task 15's `dueForRing`.
- **Recovery is the tick's alone.** A later doorbell claims nothing while a dead worker's row is `active`. Worst
  case for such a job: the lease plus two tick intervals (recovery leaves it `delayed` by its backoff).
- **Delay window.** Pre-ring jobs whose `run_at` is inside the transport's window. The window is clamped to
  `maxDeliverDelayMs` and is at least one tick interval plus the worst tick lateness. A zero-delay transport rings
  delayed jobs only once due, so on it delay precision is the tick interval.
- **In-process tick (opt-in), leader by a lease row, not an advisory lock.** A session advisory lock admits two
  holders behind a transaction pooler. The lease is one row, compared against the database clock, renewed each
  interval, with a length of about three intervals. Default interval 5 s. The lease is an efficiency device only: the
  tick itself stays safe to run concurrently, and a test proves it with two holders. Promote
  `spike/db-access/tick.ts` here and remove it from the spike directory.
- **Measured in the spike (a floor, not a promise):** at a 500 ms interval lateness was mean 343-348 ms, p95 554-562 ms,
  max 577-592 ms; at 2,000 ms mean 1,186-1,190 ms, max 2,065-2,079 ms (two runs); never early; a tick costs about 7 ms; takeover after a
  leader crash takes about the lease length. Re-measure on the real module and put the numbers in the Result, because
  `docs/limits.md` (task 22) quotes them.
- **Cloud Scheduler stays.** The 1-minute scheduler tick is the safety net and the cron source. The in-process tick
  never replaces it, and a deployment without always-on workers gets the 1-minute floor for delay, retry backoff and
  rate-limit resumption.
- **Rings are relative.** `transport.ring(items)` takes `deliverAfterMs` rounded up, and `markRung` is called only for
  the items whose result was `ok`. The tick reads the database clock for everything, never its own.

## Steps

1. **`runTick(deps, budget)`** runs these steps in order, each bounded by a batch size and the time budget, and returns a report (counts per step and a `moreWork` flag):
   1. recover expired leases (task 14);
   2. claim due crons and create their jobs (task 15);
   3. promote due delayed jobs;
   4. ring jobs that need it: `dueForRing` → `transport.ring` (with a relative `deliverAfterMs` where the transport supports it) → `markRung` for the bells that were taken;
   5. expire TTL jobs;
   6. roll up metrics and run bounded retention cleanup.
2. **Idempotent and concurrency-safe:** every step already uses `SKIP LOCKED` or a fenced update, so running two ticks at once only wastes work. Add a test with four concurrent ticks.
3. **Ring window:** compute the lookahead from `transport.capabilities.maxDeliverDelayMs`, clamped to it and at least one tick interval plus the worst tick lateness; a zero-delay transport rings delayed jobs only once they are due.
4. **Entrypoints:**
   - HTTP handler `POST /internal/tick`, authenticated (OIDC token from Cloud Scheduler or an IAM-authenticated caller; shared-secret fallback for dev only). Returns the report. Never exposes job data.
   - CLI `qcloud-tick` for Cloud Run Jobs and ECS scheduled tasks.
   - Optional in-process loop for always-on workers, leader chosen by a lease row on the database clock (not an advisory lock, see Gate decisions), default interval 5 s, for sub-minute delay, retry and rate-limit cadence (task 05's recommendation).
5. **Time budget:** loop within one invocation until `moreWork` is false or the budget is spent, so a backlog drains without waiting minutes between invocations.
6. **Metrics:** emit step durations, backlog sizes and errors through a small `Telemetry` interface (no cloud dependency here; adapters in task 71).
7. Tests: a dropped publish is repaired by the next tick; a half-failed ring batch leaves only the failed bells unrung; an expired lease is recovered and counted; a delayed job within the window is rung with a relative delay, never early; a backlog is rung up to the per-queue cap and no further in one tick; a job inside the grace is not re-rung; a cron occurrence yields one job across four concurrent ticks; a long backlog drains within the budget loop; the HTTP handler rejects missing or invalid credentials.

## Acceptance

- Chaos test: randomly drop 50% of publishes, crash workers at random, run ticks; no job is lost or stuck beyond its bound: `reRingAfterMs` plus one tick interval for a claimable job, the lease plus two tick intervals for a crashed worker's (invariant 3 holds). Run it against the Postgres store with the memory and local transports.
- Four concurrent ticks never double-create a cron job or double-count an attempt.
- The HTTP endpoint refuses unauthenticated requests and does not leak job data in its response.
- With N processes running the in-process loop, at most one holds the lease at a time and another takes over within about the lease length after the leader dies. Two ticks overlapping during a takeover change nothing (the same assertions as four concurrent ticks).
- The in-process loop's measured lateness is in the Result for at least two intervals, and no ring is ever early.
- `reRingAfterMs` greater than the tick interval is rejected at configuration time.
- `packages/store-postgres/spike/db-access/tick.ts` no longer exists.
- `spike/db-access/` is removed with its imports of `spike/doorbell/{store,ring,sweep}.ts`. Task 17 left those in place for it:
  delete whichever of them `spike/doorbell-aws/` (task 40) does not still import, and the directory when nothing imports it.

## Verify

```bash
bun run typecheck && bun run lint && bun run format:check && bun run architecture
bun test packages/maintenance
bun run test:model
```

## Risks / notes

- The tick is the system's safety net. If it silently stops, jobs only run via doorbells; add a "last successful tick" timestamp (read by the panel in task 35 and alerted on in task 71).
- A tick that runs longer than its schedule interval overlaps the next. That must be safe, and tested, not merely unlikely.
- Keep per-step batches small to avoid long transactions holding row locks.

## Result

**Done locally, on PostgreSQL 18.6, the in-memory and local transports and (for the whole-repo run) the Pub/Sub emulator, not on the Docker
PG 16 of CI.** The user told me to defer Docker-backed runs until every task is done, which departs from CLAUDE.md's "run the gate with
`QCLOUD_REQUIRE_DB=1` against the CI database" only in which Postgres it is (the runs set `QCLOUD_REQUIRE_DB=1` against the local PG 18).
Details and rejected alternatives: [docs/spikes/06-phase0-gate.md](../../../docs/spikes/06-phase0-gate.md), section "The tick as built
(task 20)", items (a) to (h), the amended task-19 item (a), and a dated amendment.

**Built**

- **`packages/maintenance/src/`** (12 files, 1,237 lines, each under 300): `tick.ts` (`runTick` one pass, `runTicks` passes until nothing is
  left or the run budget is spent), `ring.ts` (`ringDue`: ring, then `markRung` only the bells the transport took), `config.ts` (defaults and
  the validation, including `reRingAfterMs` greater than the interval, and the window floor and clamp), `loop.ts` (`TickLoop`, the opt-in
  in-process loop with the lease), `http.ts` (`POST /internal/tick`) with `auth.ts` (OIDC and the shared-secret fallback), `cli.ts`, `bin.ts`
  and `env.ts` (`qcloud-tick run | serve`), `redact.ts`, `telemetry.ts` (the small `Telemetry` interface, no cloud dependency), `index.ts`.
- **Store, one migration and one facet:** migration **v4 "tick state"** adds `qcloud_tick_state` (one row per namespace: the leader lease, the
  last tick's success and failure times; forward-only, new table, safe with old workers). `store.maintenance` gained `acquireTickLease`,
  `releaseTickLease`, `recordTick` and `tickStatus`, all on the database clock, one statement each, no session state. `schema.snapshot.txt`
  was regenerated (on PG 18; the PG 16 regeneration is owed) and `schema.planned` has a row for the lease read. `schema.planned.ts` was split
  (`schema.planned.operator.ts`) and `PostgresStore`'s options and context building moved to `store/storeContext.ts`, both to stay under
  300 lines; `PostgresStoreOptions` and `DEFAULT_LEASE_MS` are still exported from the same places.
- **SDK, one fix** (found by task 20's lateness runs, see below): `claimForBell` rechecks once when the queue has any job waiting.
- **Tests** (`packages/maintenance/test/`, 175 in 14 files: 174 pass, 1 skips without PgBouncer): `config`, `ring`, `tick` (16), `concurrent`
  (four ticks), `loop`, `auth`, `http`, `env`, `redact`, `cli`, `chaos` (6, with `chaos.ts`), `lateness` (with `lateness.ts`), `election` (4,
  real child processes, `loopChild.ts`), `pooled` (needs PgBouncer). Store tests: `tick.state.test.ts`. SDK: one added test in
  `worker.locked.test.ts`. `scripts/measure-tick-lateness.ts` prints the table below.
- **Disposal:** `spike/db-access/` is deleted whole (its `claimPath`, `fleet` and `tick` spikes are replaced by `maintenance` tests, the
  connection suites' pooled cases and `test/support/pgbouncer/`, which now holds the PgBouncer and TLS assets), and so are
  `spike/doorbell/ring.ts` and `sweep.ts`. `store.ts`, `invariants.ts` and `invariants.test.ts` stay because `spike/doorbell-aws/` (task 40)
  imports them. The disposal table in the gate document is updated.
- **Docs:** DESIGN.md section 3 (the Work bullet, the delay-precision text, the in-process tick bullet), `docs/compat.md`, `docs/PORTING.md`
  (the disposal text only: nothing in `packages/maintenance` or the lease is ported from `../qelay`, so no new rows), spike 05 and the gate
  document. CLAUDE.md corrected: the
  election suite takes about 7 s, not the 15 s I had guessed.

**Measured lateness** (the real `TickLoop`, real timers, the database's clock at both ends, a transport that adds almost nothing, 60 jobs per row,
three runs; `bun run scripts/measure-tick-lateness.ts`). Add the broker's own latency on a real queue (task 03 measured tens of ms).

| Interval | Window | Lateness mean | p95 | max | Early bells | A tick pass |
| --- | --- | --- | --- | --- | --- | --- |
| 500 ms | 0 (ring once due) | 270-292 ms | 479-513 ms | 488-495 ms (one run 1,165 ms) | 0 | 28-34 ms |
| 500 ms | 1,500 ms | 6-7 ms | 8-10 ms | 9-10 ms | 0 | 12-16 ms |
| 2,000 ms | 0 (ring once due) | 1,080-1,113 ms | 1,950-1,956 ms | 1,993-2,004 ms | 0 | 21-25 ms |
| 2,000 ms | 3,000 ms | 6-8 ms | 11-15 ms | 11-17 ms | 0 | 14-20 ms |

For comparison the spike floor was a mean of 343-348 ms at 500 ms and 1,186-1,190 ms at 2,000 ms. The 1,165 ms job came in the first case of one run
(cold connections are the likely cause), did not reproduce in twelve further runs and is not diagnosed; it is inside the contract's bound of
three intervals. The window-0 rows are the ones that apply on Pub/Sub, whose window is 0.

**Acceptance**

- *Chaos test.* **Done.** 50% of rings lost after being reported `ok`, workers killed holding jobs, ticks running: worst gap without a bell due
  1,717-1,743 ms against a bound of 2,250 ms (interval 1,000 ms); 3,222 ms against 3,750 ms (interval 2,000 ms, `reRingAfterMs` 1,500 ms);
  697 ms against 1,200 ms on the local transport with real timers. Everything enqueued completed exactly once and `attempts` equalled the number of
  deaths. A control run with no ticks breaks the bound, so the checks can fail. The harness caps the deaths of one job at 2
  (`maxCrashesPerJob`) because a queue's `maxStalls` (3) fails a job that stalls that often, by design.
- *Four concurrent ticks never double-create a cron job or double-count an attempt.* **Done** (`concurrent.test.ts`: one job per occurrence, a
  dead worker's job recovered once, promotion and expiry once; a job may be rung twice but is recorded once).
- *The endpoint refuses unauthenticated requests and leaks no job data.* **Done** (`auth.test.ts`, `http.test.ts`, `redact.test.ts`). It
  authenticates before it looks at the method, answers a bare 401, and returns counts only.
- *N processes: at most one holds the lease; takeover about a lease after the leader dies.* **Done** (`election.test.ts`, interval 200 ms,
  lease 1,000 ms, three processes): one process leads continuously and alone ticks; after `SIGKILL` another leads within lease plus an interval and
  never before the dead leader's lease ran out; after `SIGTERM` the lease is released and a follower leads within about one or two intervals; a late
  joiner never takes it from a live leader. **One stand-in:** the overlap during a takeover is not its own test. The lease is an efficiency device,
  and the four-concurrent-tick cases are the same assertions.
- *Measured lateness for at least two intervals, no early ring.* **Done**, table above: 500 ms and 2,000 ms, with and without the window, zero early
  bells.
- *`reRingAfterMs` greater than the interval is rejected at configuration.* **Done** (`config.test.ts`).
- *`spike/db-access/tick.ts` no longer exists, and `spike/db-access/` is removed.* **Done**, see Disposal.

**Design problem found, and how it was handled**

- **A bell is fungible, so task 19's recheck was too narrow.** The tick's `markRung` UPDATE holds the row locks of the jobs it just rang, a claim
  skips locked rows, and a bell delivered meanwhile claims nothing. Task 19 rechecked only when the bell's *own* job was still waiting. When another
  claim has taken the bell's job and a different waiting job is the locked one, nothing rechecked, and that job waited for the next re-ring (up to
  `reRingAfterMs` plus an interval). The lateness runs showed jobs one to three intervals late at window 0. Invariant 3 held, so this was a latency
  hole and not a correctness one. **A failing test came first** (`worker.locked.test.ts`: "a bell is fungible…"), then the fix: `claimForBell`
  rechecks once, 25 ms later, when the queue has any waiting or prioritized job (one `listJobs` probe, best effort). `BellClaim` lost its `jobId`.
  **This is not a deviation from the design**; it is recorded in the gate document, item (c), and task 19's item (a) is amended.

**What was and was not run**

- Run: typecheck, lint, format check and architecture check (clean); `bun test ./packages/maintenance` (174 pass, 1 skip); `bun run test:model`
  (17 pass); `bun test ./packages ./test` with PG 18 and the Pub/Sub emulator, `QCLOUD_REQUIRE_DB=1`: **1,705 pass, 54 skip, 0 fail**. The skips are
  the PgBouncer, TLS and ElasticMQ suites.
- **Not run:** any real cloud resource (none was needed); PgBouncer, TLS and ElasticMQ (Docker profiles). **`maintenance/pooled.test.ts` and the new
  4-store claim test in `connection.pooled.test.ts` have never run against PgBouncer.** They are written, typecheck and skip cleanly; run them in the
  final Docker pass. PG 16 and the regeneration of `schema.snapshot.txt` on it are owed.

**For task 22:** `docs/limits.md` should quote the lateness table above (window 0 for Pub/Sub, add the broker's latency), the tick pass cost, and
the worst-case figures: `reRingAfterMs` plus an interval for a claimable job whose bell was lost, the lease plus two intervals for a crashed
worker's job, and the one-minute floor for delay, backoff and rate-limit resumption without always-on workers. `qcloud-tick --help` (`cli.ts`) points to
`docs/limits.md` for the `QCLOUD_TICK_*` variables, and that file does not exist until task 22 writes it: list every variable `env.ts` reads there.
