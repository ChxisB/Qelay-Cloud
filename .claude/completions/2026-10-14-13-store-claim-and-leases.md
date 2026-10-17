# Task 13: Store: claim, leases, limits (2026-10-14)

**Done locally, on PostgreSQL 18.6, not on the Docker PG 16 of CI.** `PostgresStore` now has `claim`, `heartbeat`, `release`,
`pause`, `resume`, `setRateLimit` and `setConcurrencyLimit`. `complete`, `fail`, `tick`, `promote`, `changePriority` and `cancel`
still reject with `NotImplementedError` (tasks 14 and 15). The user told me to defer Docker-backed runs until every task is done,
which departs from CLAUDE.md's "run the gate with `QCLOUD_REQUIRE_DB=1`" rule; that run is owed at the end.

**Changed files**

- `packages/core/src/`: `jobs.ts` (`GroupPullOptions`, `ClaimOptions.group`, `RateLimit`), `store.ts` (`release`, `setRateLimit`,
  `setConcurrencyLimit`), `transitions.ts` (the `'release'` cause).
- `packages/store-postgres/src/`: `store/{claim,claimSelect,groupState,queueState,lease,leaseRules,limits,retry}.ts` (new),
  `store/{events,context,prepare}.ts`, `postgresStore.ts`, `index.ts` (`DEFAULT_LEASE_MS`, `MAX_CLAIM`), a comment in
  `schema/ddl/auxiliary.ts`.
- `packages/store-postgres/test/`: `claim.{basic,order,pause,rate,concurrency,groups,concurrent,retry,recovery}.test.ts`,
  `lease.{rules,heartbeat,release}.test.ts`; `storeHelpers.ts` gained `enqueueN`; `enqueue.basic.test.ts` expects the new
  not-yet-implemented methods.
- `test/model/`: `limits.ts`, `fakeCore.ts` (new), and edits to `fakeStore.ts`, `reference.ts`, `invariants.ts`, `world.ts`,
  `command.ts`, `commands*.ts`, `postgresTarget.ts`, `targets.ts`.
- Docs: `docs/PORTING.md` (nine rows), `docs/spikes/06-phase0-gate.md` (new "Claim, leases and limits (task 13)" section), the task
  file and `CURRENT.md`.

**Decisions** (details in the task's Result and the gate document)

- Core grew by what the claim needed: `release`, the two limit setters, and group pull options.
- Ungrouped order comes from a LIFO query and a FIFO query merged in code, never an `ORDER BY CASE`.
- The queue-state lock is shared first and exclusive on a rerun, whenever a rate or concurrency limit or a claimable group exists.
- Heartbeat and release stay single fenced `UPDATE`s, outside the retry wrapper (upstream's behaviour). A claim is replayed once on
  40001, 40P01 and 55P03.
- A claim counts no attempt and clears `rung_at`. Resume and limit changes clear due bells. Release refuses an expired lease.
- Fixed against upstream: a group's own limit applies when the worker passes no default.
- Rate-limited recovery runs at tick speed: simulated (60 jobs, 10 per second, 10 s tick: 50 s instead of 5 s), owed to task 15.

**Bugs the tests found (fixed)**

None in the store. The tests found three wrong expectations of mine (a new group joins the back of the rotation, as upstream does;
a stray SQL line; two type errors), all corrected in the tests.

**Checked** (PostgreSQL 18.6, TCP only)

- typecheck, oxlint, oxfmt and the 300-line check clean (235 files).
- `bun test packages/store-postgres --grep "claim|lease"`: 212 pass, 0 fail, 56 skip. The 12 new files: 184 pass.
- `bun run test:model`: 9 pass. A deep Postgres run (500 runs, 100 commands, seed 77) passed on the final code.
- `bun test`: 538 pass, 72 skip, 1 fail (the `fleet` cap spike on macOS, recorded in task 11).
- 8 claimers over 5,000 jobs: each job once. Concurrent proofs for the concurrency limit, the rate limit and group concurrency.
- Mutation check: without the shared-to-exclusive upgrade, the concurrency, rate and group tests fail (24 jobs where 3 are allowed).
  Files restored byte for byte.

**Not done / not verified**

- Docker, PG 16, `QCLOUD_REQUIRE_DB=1`, PgBouncer (including the never-run `connection.pooled`), TLS Postgres, the Pub/Sub emulator
  and ElasticMQ.
- The event-journal cost of the 5,000-job case (the journal is task 15).
- Real rate-limited recovery time: only a virtual-clock simulation.
- Rate-limit hot-row contention under load (task 22).
- Nothing committed, pushed or published; no real cloud resource touched.

**Next:** task 14 (store: complete, fail, retry, DLQ, recovery).
