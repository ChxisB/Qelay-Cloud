# Qelay-Cloud v1.0.0: build plan

Build Qelay-Cloud as described in [DESIGN.md](../../../DESIGN.md): a Qelay-shaped job queue on managed cloud
services (GCP first, then AWS), with Postgres as the authoritative job-state store and the cloud queue as a
"doorbell", plus a cloned control panel.

- **Design source:** [DESIGN.md](../../../DESIGN.md) (decisions D1-D7, the doorbell model, phases, risks).
- **Upstream code to port from:** `../qelay` (queue engine, MIT) and
  `../qelay-control-panel` (React 19 + Bun panel). Both are read-only inputs. Never edit them from here.
- **Baseline:** task 00 turned `Qelay-Cloud/` into a git repository (branch `main`, nothing committed yet) and a Bun monorepo with the gate.
- **Progress:** 40 of 42 tasks done (00-06, 10-22, 30-37, 40, 41, 42, 43, 50, 51, 52, 60, 61, 62, 70, 71). The user gave the step-9 go-ahead on 2026-10-14 ("continue through the
  remaining tasks"), so Phase 1 is open; the open questions from task 06 took the plan-as-written defaults (see task 06's
  Result). Real-cloud steps need D9; task 03's step 8, task 04's step 6 and task 05's steps 3 and 4 (real instance) were
  not run. Tasks 11 to 22 were verified on a local PostgreSQL 18 only (17, 19, 20 and 22 also on the Pub/Sub emulator, with no real project; 21 is a Terraform plan against a placeholder token, never applied; 22 closed Phase 1 locally and its step-8 sign-off is still owed; 30 to 37 are also local only (37 closed Phase 2 locally; its step-7 sign-off is owed and no image was scanned); 33 ran no live-API e2e; 34 and 35 ran Chromium and WebKit but not Firefox or the CI `e2e` job; 36 built no image, applied nothing, and its smoke test ran against local processes; 40 ran on the ElasticMQ 1.7.1 jar, not real SQS, with no image built; 41 ran the contract suite and scenarios on the fake, local Postgres, the Pub/Sub emulator and the ElasticMQ jar, with no real cloud, and its CI `transports` job and nightly workflow were never run; 42 is a Terraform plan against placeholder credentials with 731 plan assertions, never applied, with the changed CI `terraform` job never run on GitHub; 43 is a Terraform plan (2,651 assertions) and a smoke test against local processes and the ElasticMQ jar, never applied, with no image built; 50 ran on local PostgreSQL 18, the Pub/Sub emulator and ElasticMQ, with the PG 16 snapshot and EXPLAIN still owed; 51 ran on the same local services plus Chromium and WebKit e2e, not Firefox, with the PG 16 snapshot and EXPLAIN for migration 7 still owed; 52 ran on the same local services plus Chromium and WebKit e2e, sent requests only to local test receivers, and leaves the PG 16 snapshot and EXPLAIN for migration 8, a real VPC's egress and an independent SSRF review (task 72) owed; 60 and 61 ran on the same local services; 62 ran on the same local services plus Chromium and WebKit e2e, not Firefox, adds migrations 10 and 11 with the PG 16 snapshot and EXPLAIN owed, and reads a whole run per request; 70 ran `docs:check` and its quickstart blocks on local PostgreSQL 18, no clean-machine 15-minute walkthrough, its CI step never run on GitHub, cloud quickstarts never run on a real account; 71 ran its 18 game day drills on local PostgreSQL 18, the Pub/Sub emulator and ElasticMQ, no alert has fired on a real cloud, OTLP export was never exercised and the shipped maintenance CLI exports no metrics; 72 is a self-review and is NOT counted: its work is done locally but medium finding F-2 (a payload decodes far larger than its 1 MiB, 357 MB for 20 jobs in one list call) is open for your decision, the images were never scanned and no SBOM exists, and an independent test is recommended; 73 is prepared and NOT counted: the clean-checkout gate, both model runs, the scenarios on the three emulators, 70 of 70 e2e on Chromium and WebKit, the docs, routes and notices checks and `terraform validate` on the four roots all passed on 2026-10-17, but your workflow decision (D7) and release-scope sign-off are outstanding, nothing was published, tagged, pushed or version-bumped, and no real cloud, PG 16, Docker profile, image scan or Firefox run happened), by the user's instruction to defer Docker until every task is
  done: PgBouncer, TLS-compose, PG 16 and `QCLOUD_REQUIRE_DB=1` runs are owed at the end (see its Result).

## Phase 0 gate: what changed (task 06, 2026-10-13)

**Verdict: go.** D5 is decided (Postgres authoritative, doorbell, port). Evidence and the nine design corrections are in
[docs/spikes/06-phase0-gate.md](../../../docs/spikes/06-phase0-gate.md), and are applied in [DESIGN.md](../../../DESIGN.md).
Tasks 10-22 keep their order and dependencies; no task was added or removed. Each affected task has a
**Gate decisions (task 06)** section that is binding, and a few plainly wrong steps were corrected in place.

Conditions on the go:

1. **The model harness must reach the real store.** It has only run against a fake. Task 11 adds the clock seam; tasks 13
   and 14 are not done until `bun run test:model` passes on the Postgres store.
2. **No result came from a real broker or database service.** Task 22 runs the scenario suite on a real project (D9) or
   records it as not run. The unproven list is in the gate write-up.
3. **`docs/limits.md` (task 22) states delay precision per hosting mode** in its first table.

What changed, by task:

| Task | Change |
|------|--------|
| 10 | Interfaces are settled (DESIGN.md section 5): `DeliveryTransport` with `RingItem`, `Delivery`, per-item relative delay and one cloud queue per Qelay queue; `StateStore` with an injected `Clock`, rings returned by mutations, no `now`. |
| 11 | Event journal kept. Connection factory carries the deadline wrapper, budget validation, TLS and pooler rules. `rung_at` semantics and the clock seam. |
| 12 | `enqueue` returns rings with `dueInMs`; `markRung` per bell; a grace for an unrung job. Decide `nextval` or `group_sequence` for grouped admission. |
| 13 | Step 2 corrected (claim does not count an attempt). `sessionLimits` is kept. |
| 14 | Retry and recovery clear `rung_at`. Recovery belongs to the tick alone. |
| 15 | `dueForRing` has a per-queue cap and a grace; the ring window is clamped to the transport. |
| 16 | A direct `listenUrl`; the poll fallback is required. |
| 17 | Filtered subscription per queue; no Cloud Tasks relay; ack after the claim; the DLQ is a metric; Bun and the official client first. |
| 18 | Step 4 reworded: `enqueue` returns the rings, `markRung` per bell, the tick (not a "sweep") repairs. Not in the original list; a small section was added. |
| 19 | Store calls under a deadline; `close({ timeout })`; the worker's own slot semaphore. |
| 20 | In-process tick uses a lease row, not an advisory lock; cap, grace and the budget loop. |
| 21 | Connection ceiling (`max instances x pool`) in the plan; TLS; pooler option. |
| 22 | Spike directories must be gone; real-run gaps in `docs/limits.md`. |
| 40, 41 | The SQS transport follows the spike's `transport.ts` with the gate's changes; D2 on real SQS; emulator gaps. |
| 35, 37 | Wording only: "sweep" is now "tick". No other change to Phase 2 was made at the gate. |

## How to use

Work the tasks in the order below. Each task file has Goal / Scope / Steps / Acceptance / Verify / Risks and an
empty **Result** section. Fill it in when the task is done (what changed, what was measured, what was skipped).
"Done" means the Acceptance list is true and the Verify commands were run, not that the code was written.

The tens digit of a task number is a group, not the DESIGN.md phase number. Mapping: `0x` spikes (Phase 0),
`1x` core on GCP (Phase 1), `3x` control plane (Phase 2), `4x` AWS (Phase 3), `5x` flows and webhooks (Phase 4),
`6x` Workflow Engine (Phase 5), `7x` release (Phase 6). Each task file's header names its phase. The gap at `2x` is
deliberate and leaves room to insert more core work without renumbering.

## Status

| # | Task | Depends on | Status |
|---|------|-----------|--------|
| 00 | [Repo bootstrap and quality gate](00-repo-bootstrap.md) | D5 | done |
| 01 | [Spike: port inventory and broker coupling](01-spike-postgres-port.md) | 00 | done |
| 02 | [StateStore model-test harness](02-store-model-harness.md) | 00 | done |
| 03 | [Spike: doorbell on Pub/Sub](03-spike-doorbell-gcp.md) | 01 | done (real-project step not run, needs D9) |
| 04 | [Spike: doorbell on SQS](04-spike-doorbell-aws.md) | 01 | done (real-account step not run, needs D9) |
| 05 | [Spike: serverless DB access and delay](05-spike-db-access-and-delay.md) | 01 | done (real-instance steps not run, needs D9) |
| 06 | [Phase 0 gate: go/no-go and design update](06-phase0-gate.md) | 01-05 | done (go-ahead given 2026-10-14, plan-as-written defaults) |
| 10 | [Core types, state machine, interfaces](10-core-types-and-interfaces.md) | 06 | done |
| 11 | [Postgres schema and migrations](11-postgres-schema-and-migrations.md) | 10 | done |
| 12 | [Store: enqueue, admission, dedup](12-store-enqueue.md) | 11 | done |
| 13 | [Store: claim, leases, limits](13-store-claim-and-leases.md) | 12 | done |
| 14 | [Store: complete, fail, retry, DLQ, recovery](14-store-complete-fail-dlq.md) | 13 | done |
| 15 | [Store: delay, cron, events, logs, metrics, workers](15-store-delay-cron-observability.md) | 14 | done |
| 16 | [transport-local](16-transport-local.md) | 10 | done |
| 17 | [transport-gcp (Pub/Sub)](17-transport-gcp.md) | 10, 03 | done |
| 18 | [SDK: Queue (producer)](18-sdk-queue.md) | 12, 16 | done |
| 19 | [SDK: Worker and QueueEvents](19-sdk-worker-and-events.md) | 14, 16, 18 | done |
| 20 | [Maintenance tick](20-maintenance-tick.md) | 15, 16 | done |
| 21 | [Infra: GCP Terraform](21-infra-gcp.md) | 17, 20 | done locally (apply not run: needs D9) |
| 22 | [Phase 1 gate: core on GCP end to end](22-phase1-gate.md) | 17-21 | done locally (GCP run not made: needs D9; sign-off not obtained) |
| 30 | [Control API: core, auth, capabilities](30-control-api-core.md) | 15 | done locally |
| 31 | [Control API: jobs and queues](31-control-api-jobs-and-queues.md) | 30 | done locally |
| 32 | [Control API: DLQ, cron, workers, events, metrics](32-control-api-dlq-cron-workers-events.md) | 31 | done locally |
| 33 | [Panel: clone and rebrand baseline](33-panel-clone-baseline.md) | 00, D8 | done locally |
| 34 | [Panel: provider wiring and capability gating](34-panel-provider-wiring.md) | 31, 32, 33 | done locally |
| 35 | [Panel: Transport page and Deployment status](35-panel-transport-and-deployment.md) | 20, 34 | done locally |
| 36 | [Control plane deploy on GCP](36-control-plane-deploy-gcp.md) | 21, 34, 35 | done locally (apply needs D9; images not built) |
| 37 | [Phase 2 gate: operator walkthrough](37-phase2-gate.md) | 35, 36 | done locally (GCP run not made: needs D9; container scan not run; sign-off not obtained) |
| 40 | [transport-aws (SQS)](40-transport-aws.md) | 10, 04, 16 | done locally (emulator only; real SQS not run: needs D9) |
| 41 | [Multi-cloud contract suite](41-contract-suite-multicloud.md) | 17, 40 | done locally (emulators only; real clouds not run: needs D9; CI jobs not run) |
| 42 | [Infra: AWS Terraform](42-infra-aws.md) | 40, 20 | done locally (planned offline with placeholder credentials, never applied: needs D9; CI job not run) |
| 43 | [Control plane on AWS](43-control-plane-aws.md) | 37, 41, 42 | done locally (planned offline, never applied: needs D9; smoke test on the local ElasticMQ stack; no image built) |
| 50 | [FlowProducer on Postgres](50-flowproducer.md) | 22 | done locally (PG 18, emulators only; real clouds not run: needs D9; PG 16 snapshot and EXPLAIN owed) |
| 51 | [Flows: Control API and panel](51-flows-control-api-and-panel.md) | 50, 34 | done locally (PG 18, emulators, Chromium and WebKit e2e; Firefox cannot launch here; PG 16 snapshot and EXPLAIN owed) |
| 52 | [Persisted webhooks](52-webhooks.md) | 32, 20 | done locally (PG 18, emulators, Chromium and WebKit e2e; no real receiver or VPC egress run; independent SSRF review owed in 72; PG 16 snapshot and EXPLAIN owed) |
| 60 | [Postgres WorkflowStore](60-workflow-store.md) | 50, D7 | done locally (PG 18, emulators only; version-fenced `update`, durable wait deadlines, differential model; PG 16 snapshot and EXPLAIN owed) |
| 61 | [Workflow Engine in the SDK](61-workflow-engine-sdk.md) | 60, 19, 20 | done locally (PG 18, emulators only; engine on queue jobs and the tick; three upstream model invariants relaxed, disclosed; real clouds not run: needs D9) |
| 62 | [Workflows: Control API and panel](62-workflows-control-api-and-panel.md) | 61, 34 | done locally (PG 18, emulators, Chromium and WebKit e2e; Firefox cannot launch here; migrations 10 and 11, PG 16 snapshot and EXPLAIN owed; a run's read is the whole run, see limits 13; payloads visible to every viewer, review in 72) |
| 70 | [Documentation](70-docs.md) | 43, 51, 52 | done locally (PG 18; local quickstart blocks run by `docs:check`, cloud ones `notrun`; 15-minute newcomer test and the CI `Documentation` step not run; real clouds not run: needs D9) |
| 71 | [Observability and runbooks](71-observability-and-runbooks.md) | 43 | done locally (PG 18, Pub/Sub emulator, ElasticMQ; 18 game day drills pass; no alert has fired on a real cloud and no runbook ran on one: needs D9; OTLP export never exercised) |
| 72 | [Security review](72-security-review.md) | 43, 52 | done locally as a self-review, but **acceptance bullet 1 not met**: medium F-2 (payload decode amplification, 357 MB for 20 jobs in one list call) is open and needs your decision; container scan and SBOM not done (Docker deferred); no independent test |
| 73 | [Release prep (does not push or publish)](73-release-prep.md) | all in scope | prepared locally, **acceptance bullet 3 not met**: needs your workflow decision (D7: ship with caveats is recommended), the F-2 choice and your scope sign-off; nothing published, tagged, pushed or bumped; emulator results only |

### Suggested order (waves)

1. **00**: everything else needs the repo and the gate.
2. **01, 02** together: the port inventory and the model-test harness are the correctness core. **33** (panel clone) is independent of the backend and can run any time after 00.
3. **03, 04, 05**: spikes, in parallel. Emulators first; the real-cloud steps wait for D9.
4. **06**: the go/no-go. Nothing in Phase 1 starts before it, because it can change the design.
5. **10, 11**, then **12 → 13 → 14 → 15** (the store, strictly sequential), with **16, 17** alongside once 10 is done.
6. **18, 19, 20**: SDK and tick, once the store pieces they call exist.
7. **21, 22**: infra and the Phase 1 gate.
8. **30 → 31 → 32**, with **34, 35** following the API. **36, 37** close Phase 2.
9. **40, 41, 42, 43**: AWS, after the Phase 2 gate so the interface has settled on a real consumer.
10. **50, 51, 52** (flows, webhooks) then **60, 61, 62** (Workflow Engine). Both groups can overlap if capacity allows.
11. **70, 71, 72**, then **73** last. 73 ends at a clean local gate and a handover; it does not push or publish.

## Decisions needed (the user's call)

Each has a default. The tasks are written against the defaults, so you can start without answering.

| # | Question | Default |
|---|----------|---------|
| D1 | Worker hosting: always-on pull workers, or scale-to-zero push handlers (Cloud Run push, Lambda)? | **Always-on pull workers** (Cloud Run min instances / ECS service). A push handler is a thin add-on after v1.0.0. Pull supports jobs longer than a Lambda/push timeout. **Phase 0 gate:** the default stands, and it is also the only hosting where seconds-level delay, retry and rate-limit precision exist (the in-process tick). Push handlers get the 1-minute tick. |
| D2 | Doorbell granularity: one message per job, or one per queue-with-work? | **Per job.** Message count tracks job count, which is what autoscaling triggers and the re-ring sweep expect. **Phase 0 gate:** closed for Pub/Sub on spike 03's data (per-queue doorbells drain a backlog 1.5-1.75x faster on the emulator but are no faster under steady load and lose the backlog signal). Spike 04 did not measure granularity on SQS (ElasticMQ throughput says nothing about SQS), so it stays per job pending a load test on real SQS (task 41, needs D9). |
| D3 | What does Qelay's `namespace` column mean here? | **One namespace per environment** (dev, prod), one database per environment. Per-tenant isolation is out of scope for v1.0.0. |
| D4 | Control API authentication | **OIDC JWT verification** against a configured issuer/JWKS, plus a static admin token for local dev only. Front it with IAP (GCP) or Cognito/ALB OIDC (AWS) if you want hosted login. |
| D5 | Repo licence and attribution | **MIT**, keeping Egeo Minotti's copyright line untouched and adding a fork line `Copyright (c) 2026 ChxisB` (the same choice you made for the control panel). |
| D6 | How much of the Qelay API must the SDK match? | **BullMQ-style core:** `Queue` (add, addBulk, getJob(s), counts, pause/resume, drain/clean/obliterate under the panel's fail-closed rules), `Worker`, `QueueEvents`, `FlowProducer`. **Out of v1.0.0:** the high-level `Qelay` class features (middleware, circuit breaker, priority aging, batch processors, debounce, triggers), `SandboxedWorker`, `Forwarder`, `embedded` mode, MCP. Candidates for v1.1. |
| D7 | Is the Workflow Engine in v1.0.0? | **Yes, as the last wave.** It is the largest single item. Task 73 may cut it from the release without affecting anything else. |
| D8 | Panel: copy and diverge, or consume `qelay-control-panel` as a dependency? | **Copy and diverge.** The panel is pinned to Qelay 2.9.11 contracts and half of its surface (agent, SQLite, S3 backup) does not apply. |
| D9 | Real cloud accounts for spikes and deploy | **Emulators and `terraform plan` only** until you supply a GCP project and an AWS account and say that applying is allowed. Tasks marked "needs D9" stop at that point and report. |
| D10 | Package names and npm scope | **`qelay-cloud`** for the SDK and **`@qelay-cloud/*`** for internal packages. Availability is **not checked**; confirm before task 73. |
| D11 | Postgres versions | CI matrix mirrors Qelay (15-18); production default **16**. |
| D12 | Database driver and runtime | **Bun-only** (`Bun.SQL`, as the ported Qelay code uses it). Node-hosted workers need a driver abstraction, which is a v1.1 item. This narrows who can use the SDK; flag it if Node workers matter. |

## Rules for every task

- **English only** in code, comments, tests and docs (Qelay's repo rule).
- **Stack:** Bun 1.4.2 (`.bun-version`), strict TypeScript, Oxlint and Oxfmt, `bun test`.
- **Table prefix `qcloud_*`**, not `qelay_*`, so a Qelay-Cloud database can never be mistaken for a Qelay server database
  (Qelay's own schema guard refuses mismatched schemas).
- **Gate** (defined by task 00; run before marking any task done):
  `bun run typecheck && bun run lint && bun run format:check && bun run architecture && bun test`.
  `architecture` is the 300-line-per-file limit copied from the control panel.
- **Bugs:** write a failing test that reproduces it first, then fix (Qelay's rule). Core queue semantics changes also run `bun run test:model` (task 02).
- **Ported code** keeps the upstream MIT notice, and each ported file gets a row in `docs/PORTING.md`
  (upstream path, upstream commit `c43442c9` for qelay, what was changed or dropped).
- **Real cloud resources:** anything that creates paid or shared resources (`terraform apply`, `gcloud`, `aws` writes)
  needs your explicit go-ahead (D9). Use emulators and `terraform plan` otherwise. State what was and was not run in the task's Result.
- **No push, publish or version bump** without you. Tasks end at a clean local gate.
- **Secrets** never go in the repo, test output or logs. Connection strings come from env or the cloud secret manager.
- A task that finds the design wrong stops and records it in its Result and in task 06's gate (or DESIGN.md if after 06). It does not silently deviate.
