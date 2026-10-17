# Task 15: Store: delay, cron, events, logs, metrics, workers (2026-10-14)

**Done locally, on PostgreSQL 18.6, not on the Docker PG 16 of CI.** `PostgresStore` now has `tick`, `promote`, `changePriority` and
`cancel` (all four were `NotImplementedError`), the `crons`, `workers`, `queues`, `readModels`, `events`, `logs`, `metrics` and
`maintenance` facets, `dueForRing`, and a model harness that drives crons and concurrent ticks. The user told me to defer Docker-backed
runs until every task is done, which departs from CLAUDE.md's "run the gate with `QCLOUD_REQUIRE_DB=1`" rule; that run is owed at the end.

**Changed files**

- `packages/store-postgres/src/store/`: `delay`, `ringQuery`, `rings`, `crons`, `workers`, `queueConfig`, `settings`, `journal`, `events`,
  `eventRetention`, `logs`, `metrics`, `throughput`, `readQueries`, `readModels`, `clean`, `completions`, `groupRetention`, `tick`,
  `operator`; `src/cron/` (`parser`, `schedule`, `types`, `validate`); `facets.ts` and `postgresStore.ts` wiring.
- `packages/store-postgres/test/`: `cron.{store,fire,conditions,concurrent}`, `delay.promote`, `ring.{query,random}`,
  `tick.{compose,retention}`, `journal`, `journal.{retention,cost}`, `logs`, `throughput`, `workers`, `queue.config`, `read.models`,
  `read.plans`, `read.plans.aux`, `clean`, `completions`, `groupRetention`, `operator.actions`; helpers `planHelpers.ts`,
  `storeHelpers.ts`, `finishHelpers.ts`.
- `test/model/`: `cronModel.ts`, `invariants-cron.ts`, `commands-cron.ts` (new); `world.ts` (`sweep`, `crons`, `CRON.exactlyOnce`),
  `commands-ops.ts`, `commands.ts`, `command.ts`, `invariants.ts`, `run.ts` (`POSTGRES_ONLY`), `postgresTarget.ts` (pool of 4).
- Deleted: `packages/store-postgres/spike/ported/infrastructure/persistence/postgres/maintenanceSchedule.ts` and
  `spike/ported/shared/timers.ts`, which nothing imported.
- Docs: `docs/PORTING.md` (ten rows for this task's files, a Store (task 15) note), `docs/spikes/06-phase0-gate.md` (item 13 (k)
  replaced by the measurement, a new "Delay, crons, journal and read models (task 15)" section, the disposal row),
  `22-phase1-gate.md` (spike-removal bullet), the task file and `CURRENT.md`.

**Decisions** (details in the task's Result and the gate document)

- `promoteDue` neither clears `rung_at` nor returns rings: a promoted job keeps its pre-ring, and `dueForRing`, which runs last in the
  tick, finds a job without one. The tick returns its cron step's rings plus the ring query's, each job once.
- Crons: no catch-up, `skipMissedOnRestart` dropped, re-upsert with unchanged timing keeps `next_run`, a skipped occurrence is
  uncounted but advances `next_run`, rows claimed `FOR UPDATE SKIP LOCKED` and advanced in the claiming transaction.
- Read models: no maintained counters and no new index (every plan is index-backed on PG 18.6); offset paging is capped, deeper reads
  use the `listJobs` cursor.
- Journal: a stateless gap, window plus hard cap, one watermark row per queue. Event-journal cost on the 5,000-job claim path: about
  1.3 to 1.4 times, about 0.07 ms per job (gate item 13 (k)).
- Retention: no autonomous purge of completed jobs. `pruneCompletions` keeps the newest N records regardless of whether the job rows
  remain (upstream differs). `FOR SHARE` on a completion record is the contract for task 50's admission.
- Harness: cron commands are Postgres-only; the model has fixed-interval crons.

**Bugs the tests found (fixed)**

- The tick's `moreWork ||= await step()` skipped the step once an earlier one reported more work. A failing test came first; the fix is
  a `note(more)` fold, and it also repaired older steps of the same shape.
- Smaller ones, each found by a failing test first: a NOT NULL column (`prev_ts`) missing from a plan-test seed, the group-prune plan
  (the live check was split to match the partial indexes), a hard-coded migration count in `connection.socket.test.ts`, and the
  300-line cap (the plan helpers moved to `planHelpers.ts`). The rest were wrong expectations of mine, corrected in the tests.
- Mutation check for the cron invariant: with the row lock removed from `claimDueCrons`, `CRON.exactlyOnce` fails within 5 runs
  (`upsertCron`, `concurrentTicks`). The source was restored and diffed.

**Checked** (PostgreSQL 18.6, TCP only)

- typecheck, oxlint, oxfmt and the 300-line check clean (305 files).
- `bun test packages/store-postgres/test` with `QCLOUD_REQUIRE_DB=1`: 1,042 pass, 21 skip, 0 fail. With the spikes
  (`bun test packages/store-postgres`): 1,060 pass, 72 skip, 1 fail, the macOS `fleet` case recorded in task 11.
- `bun run test:model`: 9 pass. Postgres deep run (`QCLOUD_MODEL_TARGET=postgres QCLOUD_MODEL_RUNS=500 QCLOUD_MODEL_COMMANDS=150`,
  113 s): pass.
- Full `bun test` with `QCLOUD_REQUIRE_DB=1` (all packages, spikes included): 1,105 pass, 72 skip, 1 fail across 87 files, the macOS `fleet` "at the cap, direct" case recorded in task 11 and nothing else.

**Not done / not verified**

- Docker, PG 16, `QCLOUD_REQUIRE_DB=1` on PG 16, PgBouncer, TLS Postgres, the Pub/Sub emulator and ElasticMQ. The EXPLAIN plans and the
  regenerated schema snapshot are PG 18.6 only.
- Task 13 (h): the ring query does not know the rate window, so rate-limited recovery stays at tick speed. Task 22 decides it from data.
- `spike/ported/` is not empty (68 of 70 files, reachable through `spike/harness.ts`): tasks 17, 20 and 40 own the removal, task 22 checks.
- The cron model covers fixed intervals only; there is no permanent planted-bug test for the cron path.
- Journal cost on one machine, 4 runs; the tick's cost and the ring cap on a 100k backlog are task 22's.
- Task 50: flow-parent promotion, the failed-job dependency guard on `purgeDlq`/`removeFailed`, the `FOR SHARE` contract. Tasks 18 and
  31: clean, drain and obliterate of pending states. Tasks 30 to 32: the DLQ read-only settings rule.
- Nothing committed, pushed or published; no real cloud resource touched.

**Next:** task 16 (transport-local: Postgres variant).
