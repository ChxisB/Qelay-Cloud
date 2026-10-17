# Task 17: transport-gcp, Pub/Sub (2026-10-14)

**Done locally, on the Pub/Sub emulator and PostgreSQL 18.6, not on the Docker PG 16 of CI, and not against a real Google Cloud project.**
`packages/transport-gcp` is a production `DeliveryTransport` on Pub/Sub: `ring` publishes per queue and reports each item, `subscribe` runs a
demand-driven streaming pull on the queue's filtered subscription, `stats` come from Cloud Monitoring and degrade. The spike 03 fault
scenarios are now automated tests against `PostgresStore`. The user told me to defer Docker-backed runs until every task is done, which
departs from CLAUDE.md's "run the gate with `QCLOUD_REQUIRE_DB=1`" rule; that run is owed at the end. Step 9 (a real project) was not run:
D9 was not granted.

**Changed files**

- `packages/transport-gcp/src/`: `transport.ts`, `publisher.ts`, `receiver.ts`, `bell.ts`, `names.ts`, `monitoring.ts`, `provision.ts`,
  `options.ts`, `index.ts` (new).
- `packages/transport-gcp/test/`: `names`, `ring`, `receive`, `stats`, `delivery`, `crash`, `ledger` tests and the helpers `support.ts`,
  `scenario.ts`, `ledger.ts`, `testWorker.ts`, `crashingWorker.ts`, `lines.ts`, `ringing.ts`.
- `test/contract/`: `pubsub.test.ts` (new), `harness.ts` (new, the harness types and `ContractOptions`), `transport.ts` (a per-suite
  `timeoutMs`; the delayed-bell case branches on `maxDeliverDelayMs`).
- `packages/store-postgres/spike/doorbell/`: the replaced scenarios, worker, Pub/Sub helpers and measurement tools deleted (7 files and
  `tools/`).
- Docs: `docs/spikes/06-phase0-gate.md` (section "The Pub/Sub transport (task 17)", items (a) to (j), and a dated amendment),
  `docs/spikes/03-doorbell-gcp.md`, `CLAUDE.md`, `22-phase1-gate.md`, `20-maintenance-tick.md`, `40-transport-aws.md`, the task 17 file,
  `CURRENT.md`. No `docs/PORTING.md` rows: nothing was ported from `../qelay`.

**Decisions** (details in the task's Result and the gate document)

- One topic per environment, one filtered subscription per queue; resource names come from a reversible, collision-safe encoding.
- `maxDeliverDelayMs: 0`: a delayed item is `delay-too-long`, and the tick rings it when due. `attemptCount: 'approximate'`,
  `retryGranularityMs: 1000`, `maxRingBatch: 1000`.
- Ack after the claim attempt. A bell with no capacity waits un-acked in a local FIFO; `maxHeld` (8) bounds what a process holds.
  `nack(retryInMs)` is held locally up to `maxNackHoldMs` (30 s) and burns no delivery attempt.
- The official client is kept (it runs under Bun 1.4.2 against the emulator), with `allowExcessMessages: true` so a `WAIT` close is prompt.
- A malformed body is `bell: null`; the worker nacks it and the subscription dead-letters it. The DLQ is a metric and is never replayed.
- `stats`: Cloud Monitoring, cached, `source`/`observedAt`/`maxStalenessMs` (5 min lag plus the cache), `null` for what is unknown,
  `inFlight` always null, `delayed` 0, and `unavailable` (never a throw) on an emulator or a failing API.

**Bugs the tests found (fixed)**

- **The recovered job failed instead of retrying** (the crash tests timed out). A recovered lease spends an attempt and the default
  `attempts` is 1, so the job failed for good. The scenarios now enqueue with `attempts: 3`. This is the store's rule, recorded in the gate
  document (binding for task 30: build the worker's store with the worker's lease length, and give a job that must survive a crash 2 or
  more attempts).
- **`staleComplete` once returned `ok: true`:** a heartbeat the dead worker sent just before the kill could still land. The test now reads
  `lease_until` against the database clock in one statement.
- **A `WAIT` close took seconds** with `allowExcessMessages: false`: set to `true`, with a regression test.
- **Three contract tests timed out in a full run** (Bun's 5 s default; a redelivery test takes 4 to 5 s with its topology; a shared fixed
  namespace let the first timeout's teardown break the next). Reproduced with `--timeout 4000`, fixed with a `timeoutMs` option on the
  contract suite (30 s for Pub/Sub), re-run green at the 4 s default.
- Smaller: `test/contract/transport.ts` went over the 300-line cap (split into `harness.ts`), a leftover `leaseUntil` call after a rename,
  and a spike directory that could not be deleted whole (below).

**Checked** (Pub/Sub emulator on 127.0.0.1:58085, PostgreSQL 18.6 on 127.0.0.1:55442, TCP only)

- `bun run typecheck`, `lint`, `format:check` and `architecture` (337 files within 300 lines) exit 0.
- `bun test packages/transport-gcp test/contract` with `QCLOUD_REQUIRE_DB=1 QCLOUD_REQUIRE_PUBSUB=1`: 106 pass, 1 todo, 0 fail, 10 files.
  `bun test test/contract`: 41 pass. `bun test --timeout 4000 test/contract/pubsub.test.ts`: 12 pass.
- Full repository `bun test` (before the contract timeout fix): 1,262 pass, 60 skip, 1 todo, 4 fail: three were the contract timeouts
  (fixed), the fourth is `spike/db-access/fleet.test.ts` "at the cap, direct" (below).

**Not done / not verified**

- A real project (D9): IAM and Application Default Credentials, the service's exponential retry backoff and best-effort dead-lettering,
  real throughput and flow control, the Bun client against the real service, and **Cloud Monitoring** (metric names, filter and response
  shape are tested against a stub only). The emulator's retry backoff is not exponential.
- "A busy worker does not hoard bells" is a `test.todo`: the emulator ignores flow control. It is the first thing the real-project run
  must show.
- **`packages/store-postgres/spike/doorbell/` still exists** (`store.ts`, `ring.ts`, `sweep.ts`, `invariants.ts`, `invariants.test.ts`),
  against the acceptance line: `spike/db-access/` and `spike/doorbell-aws/` import them. Task 20 removes `spike/db-access/`, task 40
  removes `spike/doorbell-aws/`, and the last one also removes `spike/doorbell/`; task 22 checks.
- `spike/db-access/fleet.test.ts` "at the cap, direct" fails every time on PG 18.6 (`ERR_POSTGRES_CONNECTION_REFUSED` besides 53300). It
  is a spike this task did not touch and task 20 removes; recheck it in the Docker run on PG 16. The full run was not repeated after the
  timeout fix.
- Docker, PG 16, `QCLOUD_REQUIRE_DB=1` on PG 16, PgBouncer, TLS, ElasticMQ, `bun run test:model` (no queue semantics changed). `bun run
  test:contract` is still the task-41 placeholder.
- Nothing committed, pushed or published; no real cloud resource touched.

**Next:** task 18 (SDK: Queue, the producer; depends on 12 and 16).
