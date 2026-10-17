# 41 — Multi-cloud contract suite

**Status:** done locally (emulators only; real clouds not run, D9) · **Depends on:** 17, 40 · **Phase:** 3

## Goal

One parameterised test suite that every `DeliveryTransport` must pass, and an end-to-end scenario run that is identical across local, GCP and AWS, so cloud differences are visible in a table rather than discovered in production.

## Scope

In: extend the contract suite from task 16, fault-injection scenarios, the end-to-end scenario run per transport, a compatibility matrix document, CI wiring.
Out: new transports; real-cloud runs (they stay behind D9 and a manual flag).

## Gate decisions (task 06)

Binding. Evidence: [docs/spikes/06-phase0-gate.md](../../../docs/spikes/06-phase0-gate.md).

- **The suite is written against the settled interface** (task 10): per-item `RingResult`, relative `deliverAfterMs`,
  `Delivery.ack` and `nack(retryInMs?)`, demand-driven `capacity()`, `stats` with `source`, `observedAt`,
  `maxStalenessMs` and nullable counts. The fault wrapper (step 4) can fail an individual `ring` item, not only a
  whole call, and carries over the spike's `faults.ts` and scenario list.
- **Behaviours every transport must show,** on top of step 1's list:
  - a half-failed `ring` batch: only the failed items are reported, and the store marks only the others;
  - a bell for queue A never reaches a subscriber of queue B (one cloud queue per Qelay queue);
  - a bell for a job that already completed claims nothing and is acked (bells are fungible);
  - a delay is never delivered early, and a delay above `maxDeliverDelayMs` is `delay-too-long`, never clamped;
  - ack happens after the claim attempt, so a long job holds no bell;
  - a dead worker's job is recovered by the tick, not by a later bell;
  - a malformed bell reaches the doorbell DLQ and is counted, and the DLQ is a metric that is never replayed.
- **Capability-conditional:** delayed-delivery tests run only where `maxDeliverDelayMs > 0`. A transport at 0 passes
  the same end-to-end scenario through the tick, with its delay precision stated (the tick interval).
- **D2 on real SQS.** Per-job doorbells versus per-queue is decided on Pub/Sub data only. A load test of both
  granularities on real SQS runs behind `QCLOUD_REAL_CLOUD=1` and D9, with request count and cost recorded. Until it
  has run, `docs/transports.md` says "SQS: not measured; per job by default".
- **"Emulator only" rows in the matrix** at least: the Pub/Sub emulator's non-exponential retry backoff, and
  ElasticMQ's receive counts, stale-handle deletes and `Failed[]`. A result from an emulator is never presented as
  proof about the service.
- **The delay-precision figures in `docs/transports.md` match `docs/limits.md`** (task 22); a test compares them, as
  it does the capability declarations.
- **Housekeeping:** replace the failing `test:contract` placeholder script in `package.json` and its note in
  `CLAUDE.md` when the suite lands.

## Steps

1. **Extend the contract suite** with every behaviour learned in the spikes and tasks 17 and 40: at-least-once delivery on handler error; delivery after a dropped acknowledgement; duplicate doorbells; late doorbells (job already completed); doorbells for deleted jobs; poison doorbell reaches the transport DLQ and is counted in `stats`; concurrency bound; `close` with in-flight work; reconnect after a network failure; behaviour with an empty claim.
2. **Capability-conditional tests:** tests for delayed delivery run only when `maxDeliverDelayMs > 0`; transports that cannot delay must pass the same end-to-end scenario through the tick instead.
3. **End-to-end scenarios** from task 22, parameterised by transport: run them against the local transport, the Pub/Sub emulator and the SQS emulator in CI. Real clouds run only with an explicit flag (`QCLOUD_REAL_CLOUD=1`) and credentials.
4. **Fault injection** common to all transports, at the boundary: a wrapper transport that drops, duplicates, delays or reorders `ring` and delivery, and fails individual `ring` items; the model harness (task 02) and the scenarios both use it.
5. **Compatibility matrix** in `docs/transports.md`: per transport, delay mechanism and limits, ordering, at-least-once behaviour, DLQ behaviour, `stats` freshness, authentication, emulator gaps, cost drivers, and known limitations. Keep it generated from the capability declarations where possible so it cannot drift.
6. **CI:** a job per transport with its emulator as a service container; the matrix runs on pull requests; the deep model run is nightly.
7. Any divergence found: fix the transport, or add an explicit capability flag and a documented difference. Do not special-case a transport inside the SDK.

## Acceptance

- All three transports pass the same contract suite and the same scenario set (differences only where a capability flag says so).
- `docs/transports.md` exists and is consistent with each transport's declared capabilities (a test compares them).
- CI runs the full matrix on emulators on every pull request.
- Every row in `docs/transports.md` says whether it came from an emulator or a real service, and the SQS D2 row says "not measured" unless a real run is recorded.
- No transport-specific branch exists in `sdk`, `maintenance` or `store-postgres` (an architecture rule enforces it).

## Verify

```bash
bun run typecheck && bun run lint && bun run format:check && bun run architecture
bun test test/contract
bun run test:scenarios --transport=local,gcp-emulator,aws-emulator
```

## Risks / notes

- Emulators approximate redelivery and dead-lettering. The matrix must say which rows are "emulator only" so nobody reads them as proof.
- If a scenario must be skipped for a transport, the skip needs a reason in code and a row in the matrix.

## Result

**Done locally, on the in-memory fake, local PostgreSQL 18.6, the Pub/Sub emulator (`gcloud beta emulators pubsub start`) and ElasticMQ 1.7.1
(the JVM jar). No real cloud was touched (D9 was not given), no image was built, and the Docker-backed gate and the new CI jobs are owed
at the end of the plan.** Every cloud result is an **emulator** result and `docs/transports.md` labels each row that way. Findings and the
reasoning are in the dated amendment of [the gate document](../../../docs/spikes/06-phase0-gate.md).

**Built**

- **One contract suite for every `DeliveryTransport`** (`test/contract/`): 32 behaviours per transport, written once against the settled
  interface (`behaviour.ts`, `core.ts`, `faults.ts`, `capability.ts`, `transport.ts`) and run by `memory`, `postgres`, `pubsub` and `sqs`
  harnesses (`harness.ts`). Delayed-delivery tests run only where `maxDeliverDelayMs > 0`. Two behaviours (a malformed bell, an outage the
  transport can survive) are skipped on `memory` and `postgres-local` with the reason in `skips.ts`, which `docs/transports.md` prints.
- **One fault wrapper** (`test/support/faults/`): `FaultyTransport` drops, duplicates, delays, reorders and refuses `ring`, fails single items,
  and drops, duplicates and delays deliveries; the model harness (`test/model/transport.ts`) uses the same vocabulary, and
  `vocabulary.test.ts` ties the two together.
- **One end-to-end scenario set** (`test/scenarios/`): 18 scenarios on a stack per transport (a migrated schema, the SDK's `Queue` and `Worker`,
  an in-process `TickLoop`), six of them about the doorbell itself: half-failed ring batch, two queues, a bell for a finished job, a long job
  that holds no bell, a malformed bell in the dead-letter queue, a delay inside and outside the transport window.
- **`packages/transports`**, the one place that maps `QCLOUD_TRANSPORT` to an instance. `qcloud-tick` and the Control API open their transport
  through it. **An architecture rule** (`scripts/check-transport-boundary.ts`, part of `bun run architecture`, and
  `test/architecture/transportBoundary.test.ts`) fails when `core`, `sdk`, `store-postgres`, `maintenance` or `control-api` source imports a broker
  package or names a broker kind.
- **`docs/transports.md`**, generated by `bun run docs:transports` from the capability declarations, the skip reasons and the stats sources:
  declarations, matrix, delay precision, emulator-only rows, skipped behaviours, D2, how to run it. `test/contract/matrix.test.ts` fails when the
  file is stale, when a declaration differs, or when its delay-precision figures differ from `docs/limits.md` section 1.
- **`bun run test:contract` and `bun run test:scenarios`** (`scripts/test-transport.ts`) take `--transport=local,gcp-emulator,aws-emulator`.
  The real names (`gcp`, `aws`) are refused without `QCLOUD_REAL_CLOUD=1`, and with it they stop: no real-cloud stack exists until task 43.
- **CI**: a `transports` matrix job (local, Pub/Sub emulator, ElasticMQ) on every pull request in `.github/workflows/ci.yml`, and
  `.github/workflows/nightly.yml` (deep model run on the fake, Postgres and Postgres-with-workers targets; the three transports repeated three times).
- Housekeeping: the failing `test:contract` placeholder and its `CLAUDE.md` note are replaced.

**Checked**

- `bun run typecheck && bun run lint && bun run format:check && bun run architecture`: exit 0 (1,210 files within 300 lines; 210 files in 5
  packages name no broker).
- `QCLOUD_REQUIRE_DB=1 QCLOUD_REQUIRE_SQS=1 QCLOUD_REQUIRE_PUBSUB=1 bun test`: **3,949 pass, 29 skip, 1 todo, 0 fail**, 417 files, 860 s. The 29
  skips are the PgBouncer and TLS suites (Docker, owed).
- `bun test test/contract`: 163 pass, 4 skip, 0 fail, 8 files, 182 s. `bun run test:scenarios --transport=local,gcp-emulator,aws-emulator`:
  70 pass, 2 skip (the malformed-bell scenario on `memory` and `postgres`, with reasons), 0 fail, 195 s. `bun run test:model`: 17 pass, 14.5 s.
- The first full run with the Pub/Sub emulator up failed 31 tests (below); the second is the one above.

**Measured** (local machine, one run each; not measured on a CI runner)

- Model harness: the fake does about 4,000 runs of up to 200 commands per second of wall time (50,000 runs: 11.6 s); Postgres 1,000 runs of 150
  commands: 149 s; Postgres with workers: 221 s. The nightly depths (100,000 / 2,000 / 2,000 runs) are scaled from these.
- `bun test test/contract` (all four harnesses plus the matrix test): 182 s. The 18 scenarios on all four stacks: 195 s.

**Decisions**

- **No capability flag was added and no transport is special-cased.** The differences between the transports are the declared capabilities, and
  the skips are reasoned in code and printed in the matrix.
- **The matrix is generated, not written.** Rows that are claims rather than test results carry the label `design` or `not run`.
- **The SQS D2 row says "not measured; per job by default"** and stays that way until a real run is recorded (D9).
- **A malformed bell is nacked by the worker, not acknowledged** (below); the doorbell contract is unchanged.

**Found and fixed**

- **The worker acknowledged a delivery whose body was not a bell**, which deletes it: no dead-letter queue entry, no metric, nobody told. The
  transports passed the contract; the end-to-end scenario failed. The worker now nacks it after `MALFORMED_BELL_RETRY_MS` and counts
  `qcloud.worker.malformed_bell` (`packages/sdk/src/{worker,workerClaim}.ts`; test first in `packages/sdk/test/worker.malformed.test.ts`;
  `Delivery.bell` documented in `packages/core/src/transport.ts`).
- **A Pub/Sub client could leave gRPC and sign in with the machine's real credentials.** In the one process of `bun test`, the panel's tests
  register a `window` with a `fetch`; `google-gax` then used its browser transport, which asked Google's OAuth endpoint for a token with the
  Application Default Credentials. The exchange was refused (`invalid_rapt`), so nothing was reached, but a suite that "only ever talks to the
  emulator" had left it. `PubSubTransport` and every test client now spread `GRPC_ONLY` (`fallback: false`); `noBrowserFallback.test.ts` failed
  first. (I reproduced it once more in a scratch script to confirm the cause: one more refused token request, nothing else.)
- A nightly comment claimed a default of 500 runs of 150 commands; the default is 100 of 60. Corrected.

**Not run**

- **Real GCP or AWS** (`QCLOUD_REAL_CLOUD=1`): no scenario stack for them exists (task 43), and no account was used. The D2 granularity load test on
  SQS is therefore not run.
- **Docker:** the CI `transports` job, `nightly.yml` (YAML parsed, never executed on a runner) and the compose `pubsub` profile are untried; so
  are the PgBouncer and TLS suites, PostgreSQL 16, and the native ElasticMQ image.
- The Pub/Sub emulator's retry backoff is not exponential, and ElasticMQ's receive counts, stale-handle deletes and `Failed[]` differ from the
  service: those rows say "emulator only" and prove nothing about the real services.

**Owed**

- At the end of the plan: the Docker-backed gate with `QCLOUD_REQUIRE_SQS=1` and the compose emulators, a CI run of both new workflows, the
  nightly depth measured on a runner.
- With D9: a real-cloud scenario run per transport (task 43 builds the stacks), the D2 load test on SQS, the emulator-only rows re-checked
  against the services.
- Optional: the ring-window helper is still duplicated (`windowMs` in control-api).
