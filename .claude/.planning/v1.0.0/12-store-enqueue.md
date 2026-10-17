# 12 — Store: enqueue, admission, dedup

**Status:** done · **Depends on:** 11 · **Phase:** 1

## Goal

`StateStore.enqueue`: atomic single and bulk job insertion with deduplication, custom IDs, priorities, delays, TTLs and groups.
It returns which jobs now need a doorbell; ringing is the caller's next step (DESIGN.md section 3).

## Scope

In: enqueue and admission paths, dedup, custom IDs, bulk insert, the `rung_at` handshake, tests.
Out: flow-parent admission (task 50), claiming (task 13). Keep the hook points but do not implement flows here.

## Reference

`../qelay/src/infrastructure/persistence/postgres/`: `admission.ts`, `admissionStore.ts`, `admissionResult.ts`, `batchAdmission.ts`, `serialAdmission.ts`, `deduplication.ts`,
`priorityColumn.ts`, `groups.ts`; client side `src/client/jobDeduplication.ts`.

## Gate decisions (task 06)

Binding. Evidence: [docs/spikes/06-phase0-gate.md](../../../docs/spikes/06-phase0-gate.md) ("StateStore" and "The tick contract").

- **Enqueue returns the rings; it never rings.** Each admitted job that is claimable now or inside the delay window
  carries a `RingItem`-shaped value with `dueInMs` measured on the database clock at the call (0 when due). No absolute
  time crosses the store/transport boundary, and the store imports nothing from a transport.
- **`markRung` takes one entry per bell** (`{ jobId, deliverAfterMs }`) and sets `rung_at` to the database time plus
  that delay, only where the job is still claimable. A bell the broker did not take is simply not passed, so its job
  stays unrung for the tick. It is safe to call twice.
- **A job with no `rung_at` yet is not instantly stale.** The tick grants a grace so that it does not ring a job whose
  publish is still in flight (task 15 holds the query). This task's tests include an enqueue whose ring is slow.
- **`nextval` or `group_sequence`:** this task owns grouped admission, so it decides, with a test, whether
  `group_order` keeps `nextval('qcloud_group_order_seq')` or moves to `qcloud_queue_state.group_sequence`. RDS Proxy
  documents `nextval` as pinning a connection, and what it does with `prepare: false` is not verified. Record the
  decision in the Result; a change is a new migration owned by this task (task 11 keeps the sequence in schema v1).
- **Time and ids come from the injected `Clock` and id generator** (task 11, task 10): no `Date.now()`, no
  `Math.random()`, UUIDv7 ids so that LIFO order is checkable by creation.
- Enabling the harness for `enqueue`, `enqueueDelayed` and `tick` happens on the real Postgres store with the
  clock seam. This is condition 1 of the go: it is not satisfied by the fake store.

## Steps

1. Port admission with broker parameters removed. State on insert follows Qelay's rule: `delayed` if `run_at` is in the future, `prioritized` if priority is non-zero, else `waiting`.
2. **Dedup:** unique key per queue with optional expiry, enforced by the partial unique index `live_unique_key`. Return the existing job as a "duplicated" outcome, never an error.
3. **Custom IDs:** unique per namespace; enqueueing an existing ID returns the existing job; the concurrent-duplicate race resolves to exactly one row.
4. **Bulk:** batch insert in one transaction with a defined maximum batch size and a clear error beyond it. Order within a batch is preserved.
5. **TTL and group fields:** `ttl`, `timeout`, `group_id`, `group_order` assigned as Qelay does.
6. **Ringing handshake:** `enqueue` returns, per job, the job, its admission outcome (created or duplicate) and its ring (`{ bell, dueInMs }`, or none when the job is not claimable soon enough to ring). Add `store.markRung(rung: { jobId, deliverAfterMs }[])`: sets `rung_at` only where the job is still claimable. It is safe to call twice. Exact types are those fixed in task 10.
7. Tests: dedup race (two concurrent enqueues, one row); custom-ID race; bulk 1,000; each initial-state rule; ring handshake; payload round-trip including Date, Map, and bigint through the codec.
8. Enable the task 02 harness for `enqueue`, `enqueueDelayed` and `tick` commands against the real store.

## Acceptance

- Concurrent duplicate enqueues (dedup key and custom ID) always yield exactly one live row, over 1,000 randomised races.
- The model harness passes for the enqueue command set.
- `markRung` is idempotent and does not mark a job that became non-claimable, and it marks only the bells it is given (a partial ring result leaves the others unrung).
- The model harness passes for the enqueue command set **on the Postgres store** with a fake `Clock`.
- No broker identifier in the ported code; `docs/PORTING.md` updated.

## Verify

```bash
bun run typecheck && bun run lint && bun run format:check && bun run architecture
bun test packages/store-postgres --grep enqueue
bun run test:model
```

## Risks / notes

- Dedup expiry boundaries are easy to get wrong; test at `unique_expires_at` exactly equal to now.
- Do not let an enqueue fail because the doorbell could not be published. The row is committed first and the tick repairs it.
- Payload size: set and enforce a maximum, and surface it as a typed error.

## Result

**Done, verified on a local PostgreSQL 18.6 only.** The user told me to defer Docker-backed runs until every task is done, which
departs from CLAUDE.md's "run the gate with `QCLOUD_REQUIRE_DB=1`" rule. That run, on PG 16, is owed at the end.

### What exists

`PostgresStore` (`packages/store-postgres/src/postgresStore.ts`) with `enqueue`, `markRung`, `getJob`, `listJobs`, `counts` and
`listDlq`. The other `StateStore` methods reject with `NotImplementedError(method, task)`. Source is in `src/store/`
(`locks`, `prepare`, `state`, `lookup`, `plan`, `apply`, `enqueue`, `reads`, `rings`, `events`, `context`), plus `src/ids.ts`,
`src/codec.ts` and `src/errors.ts`. Provenance is in `docs/PORTING.md`.

The transaction is: validate and encode every job (no connection held) -> advisory locks -> one database `now` -> prefetch (by
id, live by dedup key, pending count per group; one statement each for the whole batch) -> pure `planAdmission` -> write (release
keys, extend windows, delete finished generations in one CTE, bulk insert in chunks of 1,000 with a row-count check) -> register
queues -> event recorder -> results.

### Decisions

- **Initial state:** `delayed` if `run_at > now`, else `prioritized` if the column priority is non-zero, else `waiting`. The column
  priority is `clamp(group.priority ?? priority ?? 0)` to the INTEGER range. Default backoff is `{ fixed, 1000 }`; default
  attempts 1.
- **Job id:** the custom id, else a UUIDv7 made from the database `now` with a 12-bit counter, so ids made in one process sort in
  creation order. The id source is injectable.
- **Limits, all typed:** 1,000 jobs per call (`BatchTooLargeError`), 1 MiB encoded payload (`PayloadTooLargeError` with size,
  limit and index), 256 characters for queue, name, custom id, dedup id and group id (non-empty, no NUL, well-formed Unicode;
  `UnsupportedOptionError`). A value the codec cannot encode is a `StoreError` naming the job.
- **Locks:** queue lifecycle (shared) -> group capacity (only groups with a `maxSize`) -> admission keys (`id:<id>`,
  `dedup:<queue>:<key>`). Each kind is taken in one statement ordered by `hashtextextended`, so overlapping batches in opposite
  orders cannot deadlock. The shared lifecycle lock is kept so `obliterate` (tasks 18 and 31) can take it exclusively.
- **Dedup:** an expired key (`unique_expires_at <= now`) is released, not deleted (`version + 1`). `extend` with a ttl moves the
  window to `now + ttl`. `replace` deletes a waiting or delayed holder and releases an active one (it keeps running without the
  key). A holder planned earlier in the same call is cancelled, never inserted, and its result has `ring: null`. A live custom
  id beats a dedup key.
- **A group at `maxSize` throws `GroupFullError` and the whole call rolls back.** Only pending jobs (waiting, prioritized,
  delayed) count; a job replaced by the same key does not count twice.
- **`nextval` or `group_sequence` (the question the gate left to this task): `group_order` stays on
  `nextval('qcloud_group_order_seq')`.** A test (`enqueue.groups.test.ts`) fixes the behaviour: values are monotonic in input
  order, concurrent admissions get distinct values, and a rolled-back call leaves a gap but never reuses a value. The reason
  to move would be RDS Proxy pinning a connection on `nextval`; what it does with `prepare: false` is not verified, and I
  have no RDS Proxy here to verify it, so that stays an open risk for task 22. `qcloud_queue_state.group_sequence` is unused;
  dropping it would be a new forward-only migration, so it stays (comment in `schema/ddl/auxiliary.ts`).
- **Rings:** `dueInMs = max(0, run_at - now)`, and a ring is returned when `dueInMs <= ringWindowMs` (store option, default 0:
  only jobs claimable now). Enqueue returns rings and never rings. A duplicate returns `ring: null`.
- **`markRung` applies to waiting, prioritized and delayed jobs, not only "claimable" ones as the gate text says.** A delayed job
  inside the transport window is pre-rung (SQS can hold a message up to 900 s), and `rung_at` is then the delivery time, so
  restricting it to claimable jobs would make the tick re-ring every pre-rung job. It is still state-guarded: a job that became
  active, finished or was removed is left alone, an unknown id is ignored, and it is scoped to the store's namespace. Two
  entries for one job record the earlier delivery; negative or NaN delays count as 0; an empty call is a no-op.
- **A job with no `rung_at` is not instantly stale** is the tick's side of the contract (task 15). This task's test covers the
  enqueue side: an enqueue whose ring is slow leaves the row unrung and `markRung` after the commit records it.
- **Reads derive the state:** a stored pending row whose `run_at <= now` reports `waiting` or `prioritized` (`effectiveState`),
  because promotion is the tick's work (task 15). `listJobs` is ordered by id with an opaque base64url cursor. `listDlq` is
  built from the failed row's columns, not from the `dlq_entry` blob.
- **No job-level `ttl` option exists in the core types, so `qcloud_jobs.ttl` stays NULL.** Step 5's "ttl ... assigned as Qelay
  does" therefore has nothing to assign. `timeout`, `group_id` and `group_order` are assigned.
- **Event journal:** an `EventRecorder` seam is called inside the transaction (a recorder that throws rolls the call back). The
  default is a no-op until task 15 brings the journal.
- **"No broker identifier in the ported code"** is read as: no broker id, session or `lease_broker_*` in code, identifiers or
  database columns (two tests scan the DB columns and the stripped source). Prose that uses "broker" for the cloud queue stays.
- **Codec:** msgpackr with `useBigIntExtension` and `moreTypes`; Date, Map, Set, bigint of any size and a `__proto__` key
  round-trip.

### Deviations and gaps

- **Harness scope.** Step 8 says "enqueue, enqueueDelayed and tick". On Postgres the harness runs `enqueue`, `enqueueDelayed`,
  `advanceClock` and `deliverLate` (`POSTGRES_COMMANDS` in `test/model/postgresTarget.ts`). `tick` needs task 15 and the claim
  and finish commands need tasks 13 and 14, so condition 1 of the go is met for the enqueue set only. Each of those tasks adds
  its commands to `POSTGRES_COMMANDS`.
- **The two plan-text claims I could not make true:** "ttl ... as Qelay does" (no ttl option, above) and `markRung` "only where
  the job is still claimable" (widened, above).
- Not run: PgBouncer, TLS Postgres, the Pub/Sub emulator, ElasticMQ, Docker, PG 16 and `QCLOUD_REQUIRE_DB=1`. Nothing was run
  against a real cloud resource. Nothing was committed, pushed or published.

### Bugs the tests found (fixed here)

1. `countPendingByGroup` multiplied a group's count when one batch named the group several times (a `maxSize` 2 group refused
   index 1 instead of 2). It now de-duplicates the requested groups before the join.
2. `planAdmission` tracked pending counts only for groups the prefetch had already counted, so a group first seen in the batch
   was under-counted. Tracking is now unconditional.

Also: a `.catch(() => undefined)` on a log insert in a test had hidden that the generation-delete CTE was unchecked; it is
replaced by a multi-table, two-namespace test that proves only the old generation's rows go.

### Evidence (PostgreSQL 18.6, TCP, `QCLOUD_TEST_DATABASE_URL`)

- `bun run typecheck && bun run lint && bun run format:check && bun run architecture`: clean (213 files within 300 lines).
- `bun test packages/store-postgres --grep enqueue`: 182 pass, 0 fail, 56 skipped (the emulator and PgBouncer suites).
- `bun test`: 344 pass, 72 skip, 1 fail. The failure is the `fleet` "at the cap, direct" spike, the macOS `somaxconn` problem
  recorded in task 11, not this task.
- `bun run test:model`: 7 pass (fake store and the planted bugs, plus the Postgres target at 100 runs, seed 20,261,014).
  A deep Postgres run (2,000 runs, up to 100 commands, seed 77) passed once by hand; it is not part of the gate.
- Races (`enqueue.races.test.ts`, seeded, 8 stores over a shared pool of 16 connections): 1,000 dedup-key races, 1,000
  custom-id races, 200 replace races, 100 terminal-reuse races, opposite-order batches with no deadlock, a group-cap race, and
  an exclusive lifecycle lock that holds enqueues. Each ends with exactly one live row.
- **Mutation checks** (changed the code, saw the tests fail, restored the file byte for byte): advisory locks off, derive-on-read
  off, live-custom-id duplicate check off.
- Test files are `enqueue.{codec,basic,limits,reads,ids,dedup,races,rings,groups,plan,events}.test.ts` and use `describeDb`
  except the pure `plan` and `codec` suites and the source scan in `events`. Two files were split to stay under the 300-line cap.
- `bun run test:model` was run because enqueue touches core queue semantics (CLAUDE.md).
