# Task 12: Store: enqueue, admission, dedup (2026-10-14)

**Done locally, on PostgreSQL 18.6, not on the Docker PG 16 of CI.** `packages/store-postgres` now has a `PostgresStore` with
`enqueue`, `markRung`, `getJob`, `listJobs`, `counts` and `listDlq`. The other `StateStore` methods reject with
`NotImplementedError(method, task)`. The user told me to defer Docker-backed runs until every task is done, which departs from
CLAUDE.md's "run the gate with `QCLOUD_REQUIRE_DB=1`" rule; that run is owed at the end.

**Changed files**

- `packages/store-postgres/src/`: `postgresStore.ts`, `ids.ts`, `codec.ts`, `errors.ts`, `index.ts`,
  `store/{locks,prepare,state,events,lookup,plan,apply,context,enqueue,reads,rings}.ts`. Comment only in
  `schema/ddl/auxiliary.ts` (the `group_sequence` decision).
- `packages/store-postgres/test/`: `enqueue.{codec,basic,limits,reads,ids,dedup,races,rings,groups,plan,events}.test.ts`;
  `storeHelpers.ts` gained `rewind`.
- `test/model/`: `postgresTarget.ts` (new), `targets.ts`, `run.ts`, `store-model.test.ts`. The harness now has a Postgres target.
- Docs: `docs/PORTING.md` (rows for the task 12 source), `docs/spikes/06-phase0-gate.md` (new "Enqueue and the ring handshake"
  section), `DESIGN.md` (one comment on `markRung`), the task file and `CURRENT.md`.

**Decisions** (details in the task's Result)

- `group_order` stays on `nextval('qcloud_group_order_seq')`; `qcloud_queue_state.group_sequence` is unused and stays in schema
  v1. RDS Proxy pinning on `nextval` with `prepare: false` is not verified (task 22).
- `markRung` applies to waiting, prioritized and delayed jobs (pre-ring of delayed jobs), not only claimable ones as the gate
  text said. Still state-guarded and namespace-scoped.
- Enqueue returns a ring when `dueInMs <= ringWindowMs` (default 0) and never rings. A duplicate returns `ring: null`.
- No job-level `ttl` option exists, so `qcloud_jobs.ttl` stays NULL.
- Limits: 1,000 jobs per call, 1 MiB payload, 256 characters per identifier, all typed errors. Default backoff `{ fixed, 1000 }`.
- Locks: queue lifecycle (shared) -> group capacity -> admission keys, each kind in one statement ordered by hash.
- Reads derive the state (a due delayed row reads as claimable); `listDlq` is built from the failed row's columns.
- The event-recorder seam is a no-op until task 15's journal.

**Bugs the tests found (fixed)**

1. `countPendingByGroup` multiplied a group's count when a batch named the group more than once.
2. `planAdmission` under-counted a group that the prefetch had not seen.

**Checked** (PostgreSQL 18.6, TCP only)

- typecheck, oxlint, oxfmt and the 300-line check clean (213 files). Two oversized test files were split to fit.
- `bun test packages/store-postgres --grep enqueue`: 182 pass, 0 fail (56 skipped: emulator and PgBouncer suites).
- `bun test`: 344 pass, 72 skip, 1 fail (the `fleet` cap spike on macOS, the `somaxconn` problem recorded in task 11).
- `bun run test:model`: 7 pass, including the Postgres target (100 runs, seed 20,261,014). A deep run of 2,000 runs, up to 100
  commands, seed 77, passed once by hand.
- 1,000 dedup-key races, 1,000 custom-id races, 200 replace races, 100 terminal-reuse races, opposite-order batches (no
  deadlock), a group-cap race and an exclusive-lifecycle-lock test.
- Mutation checks: advisory locks off, derive-on-read off, live-custom-id duplicate check off. Each made tests fail; files were
  restored byte for byte.

**Not done / not verified**

- Docker, PG 16, `QCLOUD_REQUIRE_DB=1`, PgBouncer, TLS Postgres, the Pub/Sub emulator and ElasticMQ.
- The model harness runs only `enqueue`, `enqueueDelayed`, `advanceClock` and `deliverLate` on Postgres. The plan's step 8 also
  names `tick`, which needs task 15; claim and finish commands need tasks 13 and 14. Each adds its commands to
  `POSTGRES_COMMANDS`.
- RDS Proxy behaviour with `nextval` and `prepare: false`; nothing was run against a real cloud resource.
- Nothing committed, pushed or published.

**Next:** task 13 (store: claim, leases, limits).
