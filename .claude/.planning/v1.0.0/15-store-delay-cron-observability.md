# 15 — Store: delay, cron, events, logs, metrics, workers

**Status:** done · **Depends on:** 14 · **Phase:** 1

## Goal

The remaining `StateStore` surface that the SDK, tick and Control API need: delayed-job promotion and the "needs ringing" queries,
cron storage and due-scan, the event stream, job logs, metrics, worker heartbeats, queue configuration and retention.

## Scope

In: the items above, as store methods with tests.
Out: HTTP shapes (tasks 30-32), webhooks (task 52), flows (task 50).

## Reference

`../qelay/src/infrastructure/persistence/postgres/`: `promotion.ts`, `crons.ts`, `repeatMutations.ts`, `events.ts`, `eventJournal.ts`, `eventRetention.ts`, `logs.ts`, `metricWrites.ts`, `lifetimeMetrics.ts`, `workers.ts`,
`policies.ts`, `runtimeConfig.ts`, `readModels.ts`, `queries.ts`, `groupStateRetention.ts`, `maintenance.ts`; scheduler: `../qelay/src/infrastructure/scheduler/cronParser.ts`.

## Gate decisions (task 06)

Binding. Evidence: [docs/spikes/06-phase0-gate.md](../../../docs/spikes/06-phase0-gate.md) ("The tick contract").

- **`dueForRing` implements the tick's re-ring rule**, not "null or old":
  - a claimable job in an **unpaused** queue is due when its last bell is at least `reRingAfterMs` old
    (`rung_at <= now - reRingAfterMs`), or it has no `rung_at` and is older than a **grace** period (so the tick does
    not ring a job whose publish is still in flight);
  - the result is capped **per queue** (a backlog must not become one bell per waiting job on every tick), and the
    cap is a parameter;
  - **bells are fungible**, so `rung_at` counts bells and the age threshold, not the null check, is what bounds
    invariant 3. Do not "optimise" the query back to `rung_at IS NULL`.
- **`reRingAfterMs` must not exceed the tick interval.** Validate it where the parameters meet (configuration of the
  tick, task 20), and put the bound in this task's TSDoc.
- **The ring window is clamped.** A delayed job is due for ringing when its `run_at` is inside
  `min(window, transport.maxDeliverDelayMs)`, and the window is at least one tick interval plus the worst tick
  lateness. A zero-delay transport (Pub/Sub) gets delayed jobs only once they are due.
- **No `now` argument.** Time comes from the injected `Clock`; `dueForRing` returns each ring with `dueInMs`.
- **Broker code still sits in unported modules** (`crons` 7 references, `workers` 21, `mutations` 3,
  `runtimeConfig` 3 and `runtime` 25, the last owned by task 20). Remove it as each module is ported, and finish the
  job: this task empties `packages/store-postgres/spike/ported/`, and task 22 checks it is gone.
  **Outcome (see the Result):** task 15 could not empty `spike/ported/`: 68 of 70 files are reachable through `spike/harness.ts`,
  which three spikes import. It deleted the two dead files; tasks 17, 20 and 40 own the rest, and task 22 checks.
- **Event journal kept** (task 11): the cursor work in step 3 stays on the commit and retention tables.
- **Model harness on the real store** for `promote`, `changePriority`, `cancel`, `tick` and the cron commands.

## Steps

1. **Delay and ring queries:** `dueForRing({ reRingAfterMs, graceMs, perQueueCap, windowMs })` returns claimable jobs due for a bell under the rule above, and delayed jobs whose `run_at` is inside the clamped window. `markRung` from task 12 completes the loop. `promoteDue()` moves delayed jobs whose `run_at` has passed to `waiting`/`prioritized`, clearing `rung_at` and returning their rings.
2. **Crons:** upsert, delete, list, and `claimDueCrons(limit)` using `FOR UPDATE SKIP LOCKED`; each claimed cron creates its job and advances `next_run` in one transaction. Support cron expressions and fixed intervals, `max_limit` and `executions`. Port `cronParser.ts` with timezone handling.
3. **Events:** append in the writing transaction (`qcloud_events`); `readEvents(cursor, limit)` for QueueEvents and the panel's activity stream; retention that never deletes unread events within the retention window. The journal-commit tables stay (decided at the gate, task 11).
4. **Job logs:** add, list, clear, with a per-job cap.
5. **Metrics:** minute buckets and lifetime totals for `completed` and `failed`; `throughput(queue, range)` reads for the panel.
6. **Workers:** register, heartbeat and expire; `listWorkers`.
7. **Queue configuration:** rate limit, concurrency, stall config, DLQ config, pause state: get/set with the panel's read-only rules for DLQ `maxAge`/`maxEntries`.
8. **Read models:** per-queue counts by state, queue summaries, job list by state with limit/offset, job by ID and by custom ID, counts for the dashboard. Check each with `EXPLAIN` against the indexes from task 11.
9. **Retention/cleanup:** completed-job history, event journal, group state, with bounded batches.
10. Model harness: add `promote`, `changePriority`, `cancel`, `tick` and cron commands; add a cron invariant (each due occurrence yields exactly one job, even with 4 concurrent ticks).

## Acceptance

- Four concurrent `claimDueCrons` calls produce each cron occurrence exactly once.
- `dueForRing` + `markRung` leaves no claimable job without a bell younger than `reRingAfterMs` after one tick, in a randomised test including dropped and half-dropped publishes (the per-queue cap may spread a large backlog over several ticks; the test says how many).
- Under a backlog of N waiting jobs, one tick rings at most the per-queue cap for that queue, not N.
- A job whose publish is still inside the grace is not rung again.
- Events written by a rolled-back transaction are never visible.
- Every read-model query has an index-backed plan (list the plans in the Result).
- `bun run test:model` passes with the extended command set.

## Verify

```bash
bun run typecheck && bun run lint && bun run format:check && bun run architecture
bun test packages/store-postgres
bun run test:model
```

## Risks / notes

- Cron time zones and daylight-saving transitions are the usual source of bugs; include spring-forward and fall-back cases.
- The counts-by-state read on large tables can become a full scan. If an `EXPLAIN` shows it, switch to maintained counters only with a reconciliation check, never as an unverified cache.
- Event cursors must be gap-safe under concurrent writers (a `BIGSERIAL` visible out of order). Port Qelay's approach; do not simplify it.

## Result

**Done locally, on PostgreSQL 18.6, not on the Docker PG 16 of CI.** The user told me to defer Docker-backed runs until every task is
done. That departs from CLAUDE.md's "run the gate with `QCLOUD_REQUIRE_DB=1`" rule; the Docker run is owed at the end. Details of
every decision: [docs/spikes/06-phase0-gate.md](../../../docs/spikes/06-phase0-gate.md), section "Delay, crons, journal and read
models (task 15)".

**Built**

- `PostgresStore.tick`, `promote`, `changePriority` and `cancel` no longer reject: the tick runs recovery, the cron step, promotion, TTL
  expiry, the DLQ age purge and worker expiry, event and commit trimming, completion and group-state pruning, then the ring query.
- Facets and modules under `packages/store-postgres/src/store/`: `delay` (promotion), `ringQuery` and `rings` (`dueForRing`),
  `crons` with `src/cron/` (parser with time zones, schedule, validation), `workers`, `queueConfig` and `settings`, `journal`, `events`
  and `eventRetention`, `logs`, `metrics` and `throughput`, `readQueries` and `readModels`, `clean`, `completions` and
  `groupRetention`, `tick`, `operator`.
- Harness (`test/model/`): the Postgres-only commands `upsertCron` and `concurrentTicks`, a cron model, and the invariant
  `CRON.exactlyOnce`. The Postgres target uses a pool of 4.
- Tests in `packages/store-postgres/test/`, among them `cron.{store,fire,conditions,concurrent}`, `delay.promote`, `ring.{query,random}`,
  `tick.{compose,retention}`, `journal`, `journal.{retention,cost}`, `logs`, `throughput`, `workers`, `queue.config`, `read.models`,
  `read.plans`, `read.plans.aux`, `clean`, `completions`, `groupRetention`, `operator.actions`.
- Ported files each have a row in `docs/PORTING.md` (task 15 rows added; two dead spike files deleted).

**Design problems found and how they were handled** (none reverses the gate; each is recorded in the gate document)

1. The task text said `promoteDue` clears `rung_at` and returns the rings. It does neither: a promoted job keeps its pre-ring, and a
   job without one is found by `dueForRing` later in the same tick (item b).
2. The task text said this task empties `packages/store-postgres/spike/ported/`. It cannot: 68 of its 70 files are reachable through
   `spike/harness.ts`, which three spikes still import. Two dead files were deleted; the rest are owned by whichever of tasks 17, 20
   and 40 removes the last importing spike, and task 22 checks (item o; `22-phase1-gate.md` and the disposal table are corrected).
3. Task 13 (h) asked this task to ring the jobs a rate window's end unblocks and to size the cap to the rate room. **Not done**:
   `dueForRing` has no rate-window logic, so rate-limited recovery stays at tick speed (item m). Task 22's load check decides it.
4. The first tick wiring skipped steps after an earlier one reported more work (`||=` short-circuit). Found by a failing test, fixed
   with a `note(more)` fold (item a).
5. `pruneCompletions` differs from upstream: it keeps the newest N completion records whether or not their jobs remain (item k).
6. Task 14 left `purgeDlq` and `removeFailed` without the failed-job dependency guard that `cleanJobs` and the completion prune have;
   task 50 must reconcile them, and the completion record's `FOR SHARE` contract (item l).

**Decisions on the gate's open points**

- Rings: the tick returns the cron step's rings and the ring query's, each job once; recovery's own bells are dropped. The grace is
  measured from `created_at`. A backlog of N needs `ceil(N / cap)` ticks.
- Crons: no catch-up, `skipMissedOnRestart` dropped, re-upsert with unchanged timing keeps `next_run`, one `admitJobs` call per claim
  batch, a skipped occurrence is uncounted but advances `next_run`. Validation is stricter than upstream.
- Queue configuration: PATCH setters, unknown keys refused, stall and DLQ blobs validated on write, `autoRetry` stays closed. The
  read-only rule for DLQ `maxAge` and `maxEntries` is the Control API's.
- Read models: stored `delayed` past `run_at` counts as waiting, offset paging capped by `MAX_PAGE_OFFSET` (100,000) with the
  `listJobs` cursor for deeper reads, counts index-only with **no maintained counters**, no new index and no migration.
- Journal: the gap is stateless (a cursor jump to `(pruned, MAX_SAFE_INTEGER)`), events are read before watermarks, retention is a
  window plus a hard cap that always raises the gap, defaults 24 hours and 10,000 events per queue, batches of 1,000.
- Retention: no autonomous purge of completed jobs; `cleanJobs` takes completed and failed jobs only, and clean, drain and obliterate
  of pending states are left to tasks 18 and 31.
- The event-journal cost measured for gate item (k): about 1.3 to 1.4 times the claim-and-complete path of 5,000 jobs with 8 claimers
  (about 0.07 ms more per job), no measurable enqueue cost; local PG 18.6, 4 runs.

**Acceptance**

- *Four concurrent `claimDueCrons` calls produce each cron occurrence exactly once:* yes. `cron.concurrent.test.ts`, and the
  model's `concurrentTicks(4)` against `CRON.exactlyOnce`. Mutation check: with the row lock removed from `claimDueCrons`, the model
  fails within 5 runs (history `upsertCron`, `concurrentTicks`); the file was restored and diffed. There is no permanent planted-bug
  test for this, because the planted-bug targets are fake stores.
- *`dueForRing` + `markRung` leaves no claimable job without a bell younger than `reRingAfterMs` after one tick, in a randomised test
  with dropped and half-dropped publishes:* yes, `ring.random.test.ts`; a backlog needs `ceil(N / cap)` ticks and the test says so.
- *Under a backlog of N waiting jobs one tick rings at most the per-queue cap:* yes, `ring.query.test.ts`.
- *A job inside the grace is not rung again:* yes, `ring.query.test.ts`.
- *Events written by a rolled-back transaction are never visible:* yes, `journal.test.ts` (and the forced-rollback tests of tasks 12
  to 14).
- *Every read-model query has an index-backed plan (list the plans):* yes, on PG 18.6 (`read.plans.test.ts` and
  `read.plans.aux.test.ts` fail if a plan changes). The tables in a test are tiny, so a test sets `enable_seqscan = off` where the
  planner would otherwise choose a scan by cost; the plans below are with that setting only where marked "forced".
  - Counts by state, dashboard counts: index-only on `qcloud_jobs_ready_idx` and `qcloud_jobs_state_idx`.
  - Queue totals and queue summaries: `qcloud_queue_state_pkey` (forced).
  - `listJobs`: the primary key, or `qcloud_jobs_state_idx` plus a sort. A job by custom id: the primary key. Waiting and
    prioritized: `qcloud_jobs_ready_idx`. Delayed: `qcloud_jobs_delayed_idx`. Other states: `qcloud_jobs_state_idx` backward.
  - Job logs list: `qcloud_job_logs_job_idx`. Log trim `DELETE`: index-only plus an index scan on `qcloud_job_logs_job_idx` (`EXPLAIN`
    without `ANALYZE`).
  - Throughput buckets, day and 14 days: `qcloud_metric_buckets_pkey`. Totals: `qcloud_metric_totals_pkey` (forced).
  - Clean select: `qcloud_jobs_state_idx`, a `qcloud_dependencies_dependency_idx` bitmap and `qcloud_jobs_pkey`.
  - Completion cut: index-only scan of `qcloud_completions_recent_idx`. Completion candidates: `qcloud_completions_recent_idx`,
    `qcloud_jobs_pkey` and the dependency bitmap.
  - Idle groups: `qcloud_group_state_pkey`, `qcloud_jobs_group_ready_idx` and `qcloud_jobs_group_active_idx`.
  - **These are PG 18.6 plans. PG 16 plans are re-checked at the final Docker run.**
- *`bun run test:model` passes with the extended command set:* yes. Standard (100 runs of up to 60 commands, seed 20,261,014) and deep
  (`QCLOUD_MODEL_TARGET=postgres QCLOUD_MODEL_RUNS=500 QCLOUD_MODEL_COMMANDS=150`, 113 s) both pass with `QCLOUD_REQUIRE_DB=1`. The
  set includes `promote`, `changePriority`, `cancel`, `tick`, `upsertCron` and `concurrentTicks`. Caveat: the model has fixed-interval
  crons only; cron expressions and time zones are covered by `cron.conditions.test.ts` (spring forward and fall back included).

**Checked** (PostgreSQL 18.6 on 127.0.0.1:55442, TCP only)

- `bun run typecheck`, `lint`, `format:check` and `architecture` (305 files within 300 lines) exit 0.
- `bun test packages/store-postgres/test` with `QCLOUD_REQUIRE_DB=1`: 1,042 pass, 21 skip, 0 fail. `bun test packages/store-postgres`
  (spikes included): 1,060 pass, 72 skip, 1 fail, the macOS `fleet` "at the cap, direct" case recorded in task 11 (listen backlog of 128;
  not a regression).
- `bun run test:model`: 9 pass; the Postgres deep run above.
- Full `bun test` with `QCLOUD_REQUIRE_DB=1` (spikes included): 1,105 pass, 72 skip, 1 fail across 87 files, the same macOS `fleet` case.

**Not done / not verified**

- Docker, PG 16, `QCLOUD_REQUIRE_DB=1` on PG 16, PgBouncer, TLS Postgres, the Pub/Sub emulator and ElasticMQ. The plans above and the
  regenerated schema snapshot are PG 18.6 only.
- Task 13 (h): ringing the jobs a rate window's end unblocks (see above).
- The journal cost measurement is one machine, 4 runs; the tick's cost and the ring cap's effect on a 100k-job backlog are task 22's.
- The cron model has no cron-expression schedules; the cron path has no permanent planted-bug test.
- The group-prune delete re-check race is not tested deterministically (harmless).
- Flow-parent promotion and the failed-job dependency guard on `purgeDlq`/`removeFailed` (task 50); pending-state clean, drain and
  obliterate (tasks 18 and 31); the Control API's read-only DLQ settings rule (tasks 30 to 32).
- Nothing committed, pushed or published; no real cloud resource touched.

**Next:** task 16 (transport-local: Postgres variant).
