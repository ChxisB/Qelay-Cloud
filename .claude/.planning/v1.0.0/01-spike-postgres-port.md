# 01 — Spike: port inventory and broker coupling

**Status:** done · **Depends on:** 00 · **Phase:** 0 (spike)

## Goal

Find out how hard it is to port Qelay's Postgres engine into a broker-less `store-postgres`, and decide **port vs rewrite**
module by module. This is the main schedule risk in DESIGN.md section 10, so it is measured before anything is built on it.

## Scope

In: an inventory of every module under `../qelay/src/infrastructure/persistence/postgres/`, and a throwaway port of the
enqueue → claim → lease → complete → fail → DLQ path to prove the approach.
Out: production-quality code (that is tasks 10-15). The spike code lives under `packages/store-postgres/spike/` and is deleted or promoted by task 06.

## Baseline (measured on qelay `c43442c9`)

- 86 TypeScript modules in `postgres/`, about 12,300 lines in total.
- 34 of the 86 mention "broker" (broker id, broker session, `qelay_brokers`, `lease_broker_*` columns, `lockPostgresBrokerSession`).
- The hot path alone (`claims`, `claimBatch`, `claimSelection`, `leaseStore`, `leaseRenewal`, `leaseRelease`,
  `completionLifecycle`, `completionOutcome`, `dlqLifecycle`, `recovery`) is roughly 2,000 lines.
- Claims already use `FOR UPDATE OF job SKIP LOCKED` (`claimSelection.ts`), so the concurrency model carries over.

## Steps

1. **Inventory.** A table of all 86 modules: lines, broker references (count and kind), SQL tables touched, and a verdict:
   *keep* (copy with an import fix), *adapt* (remove broker concepts), *drop* (broker-only, SQLite-only, or cloud-telemetry-only), or *rewrite*.
2. **Replace broker fencing.** Qelay fences a crashed broker via `brokerSessions`. Define the replacement: `lease_token` plus
   `lease_until` plus the `version` column as the only fence, owner = worker id. Write the invariant down before porting.
3. **Port the hot path** into the spike package with broker parameters removed, switching table names to `qcloud_*`.
   Keep the msgpackr codec (`codec.ts`) for payload, result and DLQ blobs so job data keeps its Qelay fidelity.
4. **Prove it.** Against the test Postgres: enqueue 1,000 jobs, run 8 concurrent claimers, complete them; assert each job is
   claimed exactly once; kill a claimer mid-job and assert the lease expires and the job is reclaimed with the attempt counted.
5. **Measure and record:** lines kept / adapted / dropped / rewritten, new lines written, hours spent, remaining coupling.
6. **Write** `docs/spikes/01-postgres-port.md`: the inventory, the measurements, a go/no-go on "port", and a module-by-module plan
   that tasks 11-15 can take directly. Add every ported file to `docs/PORTING.md`.

## Acceptance

- The inventory covers all 86 modules, each with a verdict.
- The spike test passes: no job claimed twice, no job lost, expired lease recovered with the attempt counted.
- The write-up states plainly whether porting is viable and what it costs, with numbers.
- If more than about half of the hot-path lines needed rewriting rather than adapting, the write-up says so and recommends a rewrite instead.

## Verify

```bash
bun run typecheck && bun run lint
bun test packages/store-postgres/spike
```

## Risks / notes

- **`Bun.SQL` and `TransactionSQL`:** the ported code uses Bun's built-in driver types. Confirm they behave the same on Cloud SQL / RDS TLS connections (task 05 covers the network side).
- **Transaction retry:** `transactionRetry.ts` and `advisoryLocks.ts` encode serialisation-failure handling. Keep that behaviour; do not simplify it in the spike.
- **Schema drift:** port from the schema at version 21 (`schema.ts`); record the exact upstream commit so later syncs are possible.
- Do not edit `../qelay`. Copy, then change.

## Result

Done 2026-10-13. Verdict: **go on "port"**. The write-up is [docs/spikes/01-postgres-port.md](../../../docs/spikes/01-postgres-port.md).

**Built.** All new code lives under `packages/store-postgres/spike/`.

- `ported/`: 70 files, 9,960 lines. This is the hot-path import closure from qelay `c43442c9` (schema version 21), produced by `tools/port.ts`, with brokers removed by hand.
- `tools/measure.ts`: measures the hand edits.
- `harness.ts` and `crashingClaimer.ts`: test glue.
- `claimOnce.test.ts` and `leaseRecovery.test.ts`: the spike tests.

Elsewhere:

- `msgpackr` was added to `store-postgres`;
- the spike directory was added to `tsconfig.tooling.json`;
- 72 rows were added to `docs/PORTING.md`.

**Fence.** `lease_token` plus `lease_until > databaseNow()`, checked under a `FOR UPDATE` row lock with `state='active'`.

- Each claim issues a fresh token, and recovery, release and terminal transitions clear it.
- `version` is bumped on every write. It is the guard for writers without a lease; lease-holder writes do not compare it.
- `lease_owner` is the worker id, which must be unique per process.

**Measured** with `tools/measure.ts` against the mechanical port:

| Measure | Lines |
| --- | ---: |
| Upstream | 10,137 |
| Kept | 9,941 (98.1%) |
| Adapted | 16 |
| Dropped | 180 (112 of them `brokerSessions.ts`) |
| New | 3 |
| Rewritten | 0 |

- **Overall:** 2.0% hand-touched.
- **Named hot-path modules:** 1,596 lines, 32 hand-touched (2.0%).
- **New spike code:** 664 lines.
- **Time:** about 28 minutes of agent wall-clock. This is not a human-effort figure.

**Remaining broker coupling** in the port is 21 comment lines. Outside the port it sits in `runtime`, `workers`, `crons` and others; the inventory gives each module's verdict.

**Inventory.** All 86 modules have a verdict:

| Verdict | Modules | Lines |
| --- | ---: | ---: |
| keep | 52 | 6,784 |
| adapt | 28 | 4,482 |
| drop | 4 | 450 |
| rewrite | 2 | 580 |

The write-up has the module plan for tasks 11-15.

**Tests.** 3 tests pass on 6 consecutive runs against the test Postgres:

- **Exactly once:** 1,000 jobs across 8 claimers, each claimed exactly once, none lost.
- **Crash:** a SIGKILLed claimer's lease expires, its token is fenced out, and the job is recovered with `attempts` 1 and then reclaimed.
- **Fail → DLQ:** a job that fails twice ends in the DLQ.

**Verify.** All of these pass:

- `bun run typecheck && bun run lint`
- `QCLOUD_REQUIRE_DB=1 bun test packages/store-postgres/spike`
- the full gate with the database up.

**Findings recorded for task 06** (details in the write-up):

1. DESIGN.md invariant 2 says "Compare-and-set on `version`". That is accurate only for writers without a lease; the lease holder is fenced by token plus deadline. This is a wording clarification, not a design change.
2. Upstream's claim does **not** increment `attempts`; fail and recovery do. Task 13 step 2 says otherwise. The recommendation is to keep upstream's semantics.
3. `sessionLimits.ts` holds PostgreSQL timeout limits, not broker sessions. Task 13 lists it as a drop; it should be kept (task 11).
4. Upstream's renewal, release and recovery run without the retry wrapper. The spike kept that; tasks 13 and 14 decide.
5. The event journal is needed for concurrent writers, not just brokers. The recommendation is to keep it (task 11).
6. Upstream baseline:
   - the task's "86 modules / ~12,300 lines" is upstream's working tree;
   - `c43442c9` has 85 modules and 12,264 lines;
   - the 86th, `legacySchemaGuard.ts`, is uncommitted and part of upstream's in-flight `bunqueue_` → `qelay_` rename.

**Not run:**

- no cloud resources;
- no TLS connection to Cloud SQL or RDS (task 05);
- no model harness (task 02);
- no commit or push.

Docker Desktop was started locally to run the test Postgres. `../qelay` was only read.
