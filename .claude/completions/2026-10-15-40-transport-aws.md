# Task 40: transport-aws, SQS (2026-10-15)

**Done locally, on the ElasticMQ 1.7.1 emulator and PostgreSQL 18.6. Not run on real Amazon SQS or CloudWatch (D9 was not
given), no image was built, and the Docker-backed gate is owed at the end of the plan.** Every number below is an
"emulator" number. `aws-sqs` is now a selectable transport in the tick, the Control API and the example.

**Changed files**

- New package `packages/transport-aws/`: `src/{transport,publisher,receiver,monitoring,deadLetters,provision,names,bell,
  options,queueUrls,errors,metrics,index}.ts`, and `test/` (`names`, `publisher`, `ring`, `stats`, `receive`,
  `subscribe.faults`, `deadLetters`, `delivery`, `crash`, `delay`, `outage`, `cost`, and the helpers `support`, `stub`,
  `scenario`, `testWorker`, `crashingWorker`).
- `test/contract/sqs.test.ts`; shared helpers `test/support/doorbell/{ledger,ledger.test,ringing,lines,util}.ts`;
  `test/support/elasticmq.conf`; `docker-compose.test.yml`.
- Wiring: `packages/maintenance/src/{env,cli}.ts`, `packages/control-api/src/runtime/{settings,open,main}.ts`,
  `examples/orders/src/runtime.ts`, `packages/control-api/Dockerfile`, `.dockerignore`, both `package.json` and
  `tsconfig.json` of maintenance and control-api, `tsconfig.tooling.json`, `bun.lock`.
- Tests updated: `packages/control-api/test/{runtime.settings,capabilities}.test.ts`,
  `packages/maintenance/test/env.test.ts`.
- Scripts: `scripts/sqs-fidelity.ts`, `scripts/sqs-fidelity-lib.ts` (new), `scripts/port.ts` (`--out` required).
- Deleted: all of `packages/store-postgres/spike/` (93 files).
- Docs: `docs/limits.md` (SQS row, env table, sections 8, 9 and the new 11), `docs/PORTING.md`,
  `docs/spikes/{04-doorbell-aws,06-phase0-gate,01-postgres-port}.md`, `DESIGN.md`, `CLAUDE.md`,
  `examples/orders/README.md`, the task file (Result, status), `CURRENT.md` (row 40, 29 of 42).

**Checked**

- `bun run typecheck && bun run lint && bun run format:check && bun run architecture`: exit 0 (1,182 files within 300
  lines).
- `QCLOUD_REQUIRE_DB=1 QCLOUD_REQUIRE_SQS=1 bun test`: 3,757 pass, 83 skip, 0 fail, 411 files, 437 s. The skips are the
  Pub/Sub emulator, PgBouncer and TLS suites, none of them SQS.
- `bun test packages/transport-aws test/contract/sqs.test.ts test/support/doorbell`: 113 pass, 0 fail, 14 files, 88 s.
- Baseline repeated five times, and three more with the recheck counter: green each time with no tick.

**Measured** (emulator, 100 jobs)

- Requests per job: 1.94 to 1.99 at concurrency 10 (10 sends, 82 to 87 receives, 100 deletes), 2.13 at concurrency 1.
  About $0.84 per million jobs at $0.40 per million requests (list price, not checked against the live page).
- Bells needing the worker's 25 ms recheck in a 50-job burst: 6.

**Decisions**

- A bell that beats its own `markRung` is answered by the worker's existing recheck (task 20). The test worker now
  rechecks too. The store is unchanged and there is no new open decision.
- The production API has no test-only heartbeat switch; heartbeat loss is a client wrapper in the tests.
- The queue topology is `ensureQueue`'s; task 42's Terraform must match it.

**Found and fixed**

- The receiver subtracted running handlers from `capacity()` twice, so a busy worker asked for too few bells.
- `stats` reported a queue's depth twice.
- A 395-line test file and a 344-line script were split for the 300-line cap; a type error in `stats.test.ts` fixed.
- `bun.lock` did not list the new workspace dependency until `bun install` ran.

**Owed**

- A real-account run (step 9): `bun scripts/sqs-fidelity.ts --real --region <r>`, then the contract suite and the fault
  scenarios against throwaway queues, then deletion. Needs D9.
- At the end of the plan: the compose ElasticMQ image (`--profile sqs`), PG 16, the fidelity tool against the image, the
  control-api image build with `transport-aws` in it.
- The AWS price check; CloudWatch metric name, dimension and unit against the real service.
- Task 41 (multi-cloud contract suite) takes its scenario list from this package; task 42 (Terraform) must set
  `QCLOUD_AWS_REGION` and create what `ensureQueue` creates.
