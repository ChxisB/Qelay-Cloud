# Task 41: Multi-cloud contract suite (2026-10-15)

**Done locally, on the in-memory fake, PostgreSQL 18.6, the Pub/Sub emulator (run on the host with `gcloud beta emulators pubsub start`) and the
ElasticMQ 1.7.1 jar. No real cloud was touched (D9 was not given), no image was built, and the new CI `transports` job, the nightly workflow and
the Docker-backed gate are owed at the end of the plan.** Every cloud number below is an "emulator" number, and `docs/transports.md` labels each
row that way. The same 32 contract behaviours and the same 18 end-to-end scenarios now run on all four transports (memory, Postgres, Pub/Sub,
SQS), and the differences are only the declared capabilities.

**Changed files**

- New package `packages/transports/` (`src/{settings,open,index}.ts`, `test/transports.test.ts`): the one place a configured name becomes a
  transport.
- `test/contract/`: `{behaviour,capability,context,core,faults,harness,skips,transport}.ts`, the four harness files
  `{memory,postgres,pubsub,sqs}.test.ts`, `matrix.test.ts`.
- `test/support/faults/` (`faultyTransport`, `deliveryFaults`, `faultCounts`, `vocabulary`, `vocabulary.test`), `test/model/transport.ts`.
- `test/scenarios/{all,scenario,scenarios.core,scenarios.doorbell,scenarios.faults,scenarios.schedule,scenarios.test,stack}.ts`.
- `test/architecture/transportBoundary.test.ts`; `scripts/{transportBoundary,check-transport-boundary,test-transport,gen-transports-doc,
  transportsDoc,transportsDocMatrix}.ts`.
- `docs/transports.md` (generated), `docs/limits.md` (cross-reference), `docs/spikes/06-phase0-gate.md` (dated amendment), `CLAUDE.md`
  (the `test:contract` placeholder note).
- `.github/workflows/ci.yml` (new `transports` matrix job), `.github/workflows/nightly.yml` (new).
- Wiring: `packages/maintenance/src/{env,cli}.ts`, `packages/control-api/src/runtime/{settings,open}.ts`, `packages/control-api/Dockerfile`, both
  `package.json` and `tsconfig.json` of maintenance and control-api, root `package.json` (`architecture`, `test:scenarios`, `test:contract`,
  `docs:transports`) and `tsconfig.json`, `bun.lock`.
- Behaviour fix: `packages/sdk/src/{worker,workerClaim}.ts`, `packages/sdk/test/worker.malformed.test.ts`, `packages/core/src/transport.ts`
  (comment).
- Pub/Sub client fix: `packages/transport-gcp/src/{grpcOnly,transport,index}.ts`, `packages/transport-gcp/test/{noBrowserFallback,support,ring,
  stats,deadLetters}.test.ts` (and `support.ts`).
- The task file (Result, status) and `CURRENT.md` (row 41, 30 of 42).

**Checked**

- `bun run typecheck && bun run lint && bun run format:check && bun run architecture`: exit 0 (1,210 files within 300 lines; 210 files in 5
  packages name no broker).
- `QCLOUD_REQUIRE_DB=1 QCLOUD_REQUIRE_SQS=1 QCLOUD_REQUIRE_PUBSUB=1 bun test`: 3,949 pass, 29 skip, 1 todo, 0 fail, 417 files, 860 s. The skips
  are the PgBouncer and TLS suites. The first run of this (3,916 pass, 31 fail) is the Pub/Sub finding below.
- `bun test test/contract`: 163 pass, 4 skip, 0 fail, 8 files, 182 s.
- `bun run test:scenarios --transport=local,gcp-emulator,aws-emulator`: 70 pass, 2 skip (malformed bell on memory and Postgres, with reasons), 0
  fail, 195 s.
- `bun run test:model`: 17 pass, 14.5 s. Nothing in the store or core semantics changed, so this is a regression check.

**Measured** (local machine, one run each)

- Model harness depth, for the nightly job: fake about 4,000 runs of up to 200 commands per second (50,000 runs: 11.6 s); Postgres 1,000 runs of
  150 commands: 149 s; Postgres with workers: 221 s. The planted-bug tests add a fixed 15 s. Not measured on a CI runner.

**Decisions**

- No capability flag was added and no transport is special-cased; skips carry a reason in `test/contract/skips.ts`, printed in the matrix.
- `docs/transports.md` is generated and a test compares it with the declarations and with `docs/limits.md`; rows that are claims, not results,
  say `design` or `not run`.
- SQS D2 stays "not measured; per job by default" until a real run is recorded.
- A malformed bell is nacked by the worker and counted, so a broker's dead-letter queue keeps it.

**Found and fixed**

- The worker acknowledged a delivery whose body was not a bell. The transports passed the contract and the end-to-end scenario failed. Now it
  nacks and counts `qcloud.worker.malformed_bell` (test first).
- A Pub/Sub client could leave gRPC when the process has a `window` with a `fetch` (the panel's tests register one), and then asked Google's
  OAuth endpoint for a token with the machine's Application Default Credentials. The exchange was refused, so nothing was reached. Production has
  no `window`; now `PubSubTransport` and the test clients use `GRPC_ONLY` and `noBrowserFallback.test.ts` pins it (test first). I reproduced the
  cause once more in a scratch script: one more refused token request.
- A nightly comment misstated the default model depth (it is 100 runs of 60 commands).

**Owed**

- The Docker-backed gate; a CI run of the `transports` job and `nightly.yml` (written and YAML-parsed only); the compose `pubsub` profile; the
  nightly depth measured on a runner.
- With D9: real GCP and AWS scenario stacks (task 43), the D2 load test on SQS, and the emulator-only rows re-checked against the services.
- The ring-window helper is still duplicated in control-api (`windowMs`).
