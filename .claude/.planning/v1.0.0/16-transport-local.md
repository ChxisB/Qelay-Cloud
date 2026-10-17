# 16 — transport-local

**Status:** done (locally, on PostgreSQL 18.6; Docker, PG 16, PgBouncer and TLS runs owed at the end) · **Depends on:** 10 · **Phase:** 1

## Goal

A `DeliveryTransport` that needs no cloud account: Postgres `LISTEN/NOTIFY` plus polling. It is the default for development and CI, and the reference
implementation every cloud transport is tested against.

## Scope

In: the transport, plus an in-process memory variant for unit tests that do not want a database.
Out: cloud transports (17, 40) and the contract suite itself (41), though this task writes the first version of it.

## Gate decisions (task 06)

Binding. Evidence: [docs/spikes/06-phase0-gate.md](../../../docs/spikes/06-phase0-gate.md), [spike 05](../../../docs/spikes/05-db-access-and-delay.md).

- **Implement the settled `DeliveryTransport`** (task 10): `ring(items)` with one `RingResult` per item and a relative,
  rounded-up `deliverAfterMs`; `subscribe(queue, handler, { capacity })` returning `{ refresh, close }`; `Delivery`
  with `ack` and `nack(retryInMs?)`; `stats(queue)` carrying `source`, `observedAt` and `maxStalenessMs`.
- **Capabilities are honest:** unbounded `maxDeliverDelayMs`, `attemptCount: 'none'`, and a `retryGranularityMs`
  equal to the poll interval.
- **A bell is never delivered earlier than its delay.** An early bell is an empty claim, which loses the wake-up. A
  delayed job is therefore not announced by `NOTIFY`: polling finds it once `run_at` has passed, and the poll interval
  is this transport's delay precision (say so in `docs/limits.md`, task 22).
- **`LISTEN` needs a direct connection.** The transport takes a `listenUrl` that bypasses any transaction pooler.
  Through a transaction pooler `LISTEN` succeeds and never delivers (measured, PgBouncer 1.26), and `NOTIFY` is fine.
  The listener is therefore never shared with the store's pool, and a deployment with no `listenUrl` behind a pooler
  runs on the poll loop alone. Both are tested.
- **Demand-driven:** a worker that is full reports capacity 0 and the transport starts no claim attempt for it. The
  poll loop and the wake both respect `capacity()`.
- **Ack follows the claim attempt**, never the job (contract suite: a slow handler holds no bell hostage).
- **The memory variant's fault controls cover the settled shape:** drop, duplicate, delay and reorder deliveries, and
  fail an individual `ring` item (a half-failed batch), so task 02 and task 41 can inject all of it.

## Steps

1. **Capabilities:** unbounded `maxDeliverDelayMs` (delayed jobs are found by polling `run_at`); the other capabilities as under Gate decisions.
2. **`ring`:** `NOTIFY qcloud_jobs_changed` with the queue name (payload size limits respected) for a bell that is due; no `NOTIFY` for a delayed bell (see above); a no-op otherwise, since the job row is already the signal. Returns `ok` for every item it accepted.
3. **`subscribe`:** one dedicated listener connection (on `listenUrl`) for `LISTEN`, a poll loop with jittered backoff as the fallback when notifications are missed or a pooler is in use, a per-queue "wake" that triggers a claim attempt, bounded by `capacity()`.
4. **Reconnect:** the listener reconnects after a connection loss and runs one catch-up poll so nothing waits for the next notification.
5. **`stats`:** depth from the store's counts, oldest claimable age from the ready index; `deadLetterDepth` = failed jobs in the DLQ for the queue.
6. **Memory variant:** same interface, in-process, deterministic, with controllable delivery for tests (drop, duplicate, delay). Task 02 uses it for fault injection.
7. **Contract suite v1** in `test/contract/`: a parameterised suite that takes a transport factory and checks the behaviours every transport must show: delivery to a subscriber, at-least-once under a thrown handler, no delivery after `close`, concurrency bound respected, `stats` shape, graceful `close` with in-flight handlers. Task 41 extends and runs it across clouds.

## Acceptance

- A producer and worker run end to end on a laptop with only the test Postgres.
- Killing the listener connection does not lose wake-ups: a catch-up poll recovers within the poll interval.
- With the store behind a transaction pooler and no `listenUrl`, jobs still run (poll only); with a direct `listenUrl`, a `NOTIFY` wakes a subscriber before the next poll.
- A subscriber at capacity 0 starts no claim attempt; a half-failed `ring` batch reports the failed items individually.
- The contract suite v1 passes for both the local and memory transports.
- The memory transport can reproduce dropped, duplicated and late deliveries on demand.

## Verify

```bash
docker compose -f docker-compose.test.yml up -d --wait
bun run typecheck && bun run lint && bun run format:check && bun run architecture
bun test packages/transport-local test/contract
```

## Risks / notes

- `LISTEN/NOTIFY` does not survive transaction-mode poolers, and the failure is silent. The poll fallback is required, not optional (task 05 findings).
- Do not let this transport grow cloud-like features. It exists to be simple and correct.

## Result

**Done locally, on PostgreSQL 18.6, not on the Docker PG 16 of CI.** The user told me to defer Docker-backed runs until every task is
done. That departs from CLAUDE.md's "run the gate with `QCLOUD_REQUIRE_DB=1`" rule; the Docker run is owed at the end. Details of
every decision: [docs/spikes/06-phase0-gate.md](../../../docs/spikes/06-phase0-gate.md), section "The local transport: NOTIFY, a poll
loop and a heartbeat (task 16)", items (a) to (h).

**Built** (`packages/transport-local/src/` unless noted)

- `postgres.ts`: `PostgresLocalTransport implements DeliveryTransport`. `ring` is one `SELECT pg_notify(...)` per batch; the payload is
  the bell as JSON. `subscribe` opens the `LISTEN` connection lazily and starts a per-queue poll loop. `stats` come from
  `store.doorbell.snapshot`. `mode`, `listening`, `listenerReconnects` and `pollOnlyReason` are readable.
- `listener.ts`: the `LISTEN` connection, a heartbeat through the pool, replacement of a connection that is not heard, and a gap
  callback that triggers a catch-up poll.
- `poller.ts`: `QueuePoller`, a jittered poll loop with backoff on probe errors, `soon()` (coalesced) and `stop()`.
- `wire.ts`: the NOTIFY payload codec (size limit, dropped oversize job id). `types.ts`: `LocalDatabase`, `QueueSource`.
- `memory.ts` (earlier part of this task) is also each listener's buffer for delayed and unsettled bells.
- Store side: `store.doorbell.hasClaimable(queue)` and `snapshot(queue)` (from task 15's work, used here), `QueueSnapshot`.
- Tests: `test/contract/postgres.test.ts` (the contract suite against the Postgres transport) and `transport.ts` (an optional
  `backlog` hook for the stats case); in `packages/transport-local/test/`: `wire`, `poller`, `postgres`, `postgres.wake`,
  `postgres.fault` and `support.ts`.
- **A fix in task 11's code** (`packages/store-postgres/src/schema/migrate.ts`, test `schema.migrate.race.test.ts`), see below.

**Design problems found and how they were handled** (none reverses the gate; each is in the gate document)

1. **The gate said a delayed job is not announced by `NOTIFY`.** The contract suite needs a delayed bell, with no job row behind it,
   to be delivered once its delay has passed and not before. The `NOTIFY` payload therefore carries the bell and its delay, and every
   listener holds delayed bells in an in-memory buffer (item a). A bell is still never delivered early, the poll still finds a delayed
   job without any bell, and the delay precision is still the poll interval.
2. **Bun's `SQL.listen` re-establishes a killed `LISTEN` backend silently** (about 400 ms, no callback), a notification sent in the gap
   is lost, and calling `listen` again adds a second handler. No hook can be trusted, so the transport sends itself a heartbeat and
   replaces the connection when it is unheard (item c).
3. **A bare `EXISTS` probe chose a sequential scan** (153,000 rows visited on a three-queue table). `hasClaimable` uses the claim's
   ordered `LIMIT 1` selects, which read the ready indexes (item d).
4. **Steps 2 and 5 of this task's text differ from the build.** The payload is the bell, not the queue name (see 1), and `stats` are
   read through `store.doorbell` and not "the store's counts" in general; depth is claimable jobs, not bells (item e).
5. **A bug in task 11's migrator** (below).

**Decisions on the gate's open points**

- Poll interval 1,000 ms, jitter plus or minus 20 %, backoff doubling up to 8 times on probe errors; heartbeat 5,000 ms; per-queue buffer
  cap 1,000 bells (the poll finds the jobs of dropped bells); visibility timeout 30 s. All but the jitter are options.
- `retryGranularityMs` is the poll interval; `maxDeliverDelayMs` is unbounded; `attemptCount: 'none'`; `maxRingBatch` 1,000.
- `ring` rejects a bell of another namespace, a non-finite delay and a bell too large even without its job id (more than 7,999 bytes);
  an oversize job id alone is dropped from the payload. A database failure makes valid items `unreachable`, as does a closed transport.
- The poll probes the store only when the worker has capacity and the buffer holds nothing ready or in flight, then rings a bell with no
  job id. A worker with capacity 0 makes no claim attempt and no read.
- A listener that cannot open (no `listenUrl` behind a pooler, or the database down) leaves the transport in poll-only mode and says why.
- The channel is an option (default `qcloud_jobs_changed`).

**Bug found and fixed in task 11's code (the migrator race)**

While running the broad suite after this work, `schema.migrate.test.ts` "four processes migrating one empty schema" failed once.
Ten parallel runs of it failed 36 of 40 times with `SchemaVersionError: "qcloud_jobs" exists but there is no migration record`.
Cause: after waiting for `pg_advisory_xact_lock`, `readRecorded` and `refuseForeignTables` used `to_regclass`, which is answered from
the backend's catalog name cache. A backend that waits on an advisory lock does not process invalidations, so it still said "absent"
for tables the lock holder had created and committed meanwhile. A failing test came first (`schema.migrate.race.test.ts`: a holder
creates a two-table stub while a starter waits; 3 of 3 failed with the production error). The fix is `relationExists`, a `pg_class`
read, for both checks. The race test now passes 3 of 3, the ten-way stress 40 of 40, and `schema.migrate.test.ts` and
`schema.test.ts` pass (18). Recorded in the gate document (item h, binding for any catalog read after a lock) and in task 11's notes.
The other `to_regclass` calls in the repository are in spike files that tasks 17, 20 and 40 remove, and in a test that reads after
the migration.

**Acceptance**

- *A producer and worker run end to end on a laptop with only the test Postgres:* yes. `postgres.wake.test.ts` enqueues through
  `PostgresStore`, rings through the transport, and a worker claims and completes through the store; with no bell at all the poll finds
  the work.
- *Killing the listener connection does not lose wake-ups; a catch-up poll recovers within the poll interval:* yes, tested two ways
  in `postgres.fault.test.ts`: `pg_terminate_backend` of the `LISTEN` backend (a bell rung in the gap is lost to `NOTIFY` and recovered
  by the poll's own bell; afterwards the connection is replaced and a later ring wakes the worker at once, with a 10 s poll and an
  unchanged probe count) and a blackholing TCP proxy (a connection that stops delivering without failing is noticed and replaced).
  A database that is unreachable at the start is retried.
- *Behind a transaction pooler with no `listenUrl` jobs still run (poll only); with a direct `listenUrl` a `NOTIFY` wakes a subscriber
  before the next poll:* **partly.** Poll-only is tested with a `LocalDatabase` whose `openListener` throws (the transport reports
  `mode: 'poll'` and why); the direct wake is tested with a 10 s poll interval and a probe counter that must not move. **PgBouncer was
  not run**, so "behind a real pooler" is not shown; it is owed at the Docker run.
- *A subscriber at capacity 0 starts no claim attempt; a half-failed `ring` batch reports the failed items individually:* yes
  (`postgres.wake.test.ts`, `postgres.test.ts`).
- *The contract suite v1 passes for both the local and memory transports:* yes, `bun test test/contract` runs 29 tests: the memory file 17 (the 12
  contract behaviours plus 5 fault-control tests) and the Postgres file 12.
- *The memory transport can reproduce dropped, duplicated and late deliveries on demand:* yes (`dropNext`, `duplicateNext`,
  `delayNext`, `failWhere`, `pick`).

**Checked** (PostgreSQL 18.6 on 127.0.0.1:55442, TCP only)

- `bun run typecheck`, `lint`, `format:check` and `architecture` (321 files within 300 lines) exit 0.
- `bun test packages/store-postgres/test test/contract packages/transport-local packages/core` with `QCLOUD_REQUIRE_DB=1`: 1,158 pass,
  21 skip, 0 fail, 81 files (207 s). `bun test packages/transport-local test/contract` alone: 73 pass; the transport-local suites
  44 pass, three runs in a row.
- `bun run test:model` with `QCLOUD_REQUIRE_DB=1`: 9 pass. No queue semantics changed in this task, so no deep run.
- Four planted bugs in the transport, one at a time: no buffer cap, delay ignored, the poll ignoring `capacity()`, the poll ignoring the
  buffer. The last was first not caught by any end-to-end test; the test "the poll stays quiet while a bell is being handled" was added.
  The sources were restored and diffed.

**Not done / not verified**

- Docker, PG 16, `QCLOUD_REQUIRE_DB=1` on PG 16, **PgBouncer** (the pooler with and without `listenUrl` through a real pooler), TLS,
  the Pub/Sub emulator and ElasticMQ. The `hasClaimable` plans were checked on PG 18.6 only; the migrator stress is PG 18.6 only.
- The `NOTIFY` fan-out cost (every listener of the channel receives every bell; cost grows with listeners times bells) is not
  measured; task 22's load check should include listeners (item g).
- Delay, nack and visibility precision at the default 1 s poll is by construction, not measured under load.
- `bun run test:contract` is still the task-41 placeholder; the contract suite runs under plain `bun test`.
- Nothing committed, pushed or published; no real cloud resource touched.

**Next:** task 17 (transport-gcp: Pub/Sub). It needs the real-cloud go-ahead (D9) for any step that creates or calls a real project.
