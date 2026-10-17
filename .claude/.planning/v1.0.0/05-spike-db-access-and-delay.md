# 05 — Spike: serverless DB access and delay precision

**Status:** done (real-cloud steps not run, needs D9) · **Depends on:** 01 · **Phase:** 0 (spike)

## Goal

Answer two operational questions before they become architecture: can many short-lived workers reach Postgres without
exhausting connections, and is tick-based delay precision acceptable on GCP.

## Scope

In: connection-budget analysis and a measured test, TLS and authentication from `Bun.SQL`, and the optional Cloud Tasks delay relay.
Out: Terraform (tasks 21, 42) and production pooling configuration.

## Steps

1. **Connection budget.** Model: workers × (claim pool + heartbeat + event writes) per process. Write the formula and the default
   per-process connection cap the SDK will enforce. Show the numbers for 10, 50 and 200 worker processes.
2. **Pooling options**, compared on cost, latency and feature fit (transactions and `FOR UPDATE SKIP LOCKED` need session or
   transaction pooling that preserves them):
   - GCP: Cloud SQL connector, Cloud SQL managed connection pooling if available for the chosen edition, or a PgBouncer sidecar.
   - AWS: RDS Proxy, or PgBouncer.
   Pooler **transaction mode** can break advisory locks and `LISTEN/NOTIFY`; record which SDK features depend on them (Qelay uses `advisoryLocks.ts`).
3. **Driver over TLS.** Confirm `Bun.SQL` connects to Cloud SQL and RDS with TLS and IAM or password auth, and survives a failover or restart with a bounded reconnect.
4. **Measured test (needs D9):** a small worker fleet against a small Cloud SQL instance (and RDS if allowed). Record connections used, claim latency (p50/p99) and failure behaviour when the cap is hit. Tear everything down.
5. **Delay relay (GCP).** Compare tick-only delay (about 1 minute precision) against a Cloud Tasks relay (a task with `scheduleTime` publishing the doorbell). Measure precision, complexity, extra IAM and cost. Recommend tick-only or relay for v1.0.0.
6. **Tick cadence.** Cloud Scheduler and EventBridge Scheduler have a 1-minute floor. Evaluate an optional in-process tick on always-on workers (with an advisory-lock leader) for finer cron and delay cadence.
7. Write `docs/spikes/05-db-access-and-delay.md`.

## Acceptance

- The connection formula and per-process default cap are written down and justified.
- A pooling recommendation exists for each cloud, with the SDK features that must avoid pooler-sensitive primitives listed.
- `Bun.SQL` over TLS is verified, or the failure is documented with a workaround.
- A clear v1.0.0 recommendation on the Cloud Tasks relay and the in-process tick.
- Nothing left running in a cloud account; the Result says what was created and removed.

## Verify

Mostly measurements and documents. Where code exists:

```bash
bun run typecheck && bun test packages/store-postgres/spike
```

## Risks / notes

- Cost and cleanup: use the smallest instance tiers, set a deletion step, and report what ran. No real-cloud step without D9.
- If transaction-mode pooling is required for scale and it breaks a feature we rely on, that is a design finding. Feed it to task 06.

## Result

Done locally on 2026-10-13. Write-up: [docs/spikes/05-db-access-and-delay.md](../../../docs/spikes/05-db-access-and-delay.md).
Spike code: `packages/store-postgres/spike/db-access/` (6 test files, 37 tests).

**Answers**

- **Formula and cap (step 1).** `direct = sum(count x (pool + listen)) + 6 reserved`. Default per-process pool **2**,
  worker `concurrency` is not in it. 10 / 50 / 200 worker processes need **32 / 112 / 412** direct connections, or 26
  behind a pooler (pool 20). Measured on real processes: peak server connections equal the formula, and 50 concurrent
  jobs on one pool of 2 held 2.
- **Cap behaviour.** Direct, the cap is a hard `53300` failure at connect time (326 to 336 of 400 operations failed
  against a role limit of 40). Behind PgBouncer the same load queued and all 400 settled.
- **Pooling (step 2).** Direct with pool 2 is the default. A transaction-mode pooler works with three rules: `prepare:
  false` (or `max_prepared_statements > 0`), no session-timeout startup parameters, schema and timeouts on the role. The
  ported code takes only transaction-level advisory locks and `NOTIFY` in transactions, so it is pooler-safe. `LISTEN`
  must bypass a pooler (silent failure otherwise). Cloud SQL managed pooling needs **Enterprise Plus** (documented).
  RDS Proxy pins on `nextval`, which grouped-job admission calls (documented, not verified).
- **Driver (step 3), local only.** TLS needs an explicit `tls: { ca }` (default is plaintext; `tls: true` does not
  verify). `password` as a function is called per connection. Unix socket via `path` works. Resets and refusals are
  handled; **a silent stall hangs a raw pool for good** (no cancel, no statement timeout, `close()` hangs). Bound it
  with a deadline wrapper (`ResilientPool`), `maxLifetime` and `close({ timeout })`.
- **Delay (steps 5, 6).** No Cloud Tasks relay in v1.0.0. Keep the 1-minute Cloud Scheduler tick. Opt-in in-process
  tick for always-on workers, leader by **lease row** (a session advisory lock gives two holders behind a pooler).
  Measured lateness: mean about half the interval plus about 100 ms, max about the interval, never early. Takeover after a
  crash is the lease length. The in-process tick fixes delay, retry backoff and rate limits together.

**Bugs found and fixed:** none in shipped code. The spike corrected its own assumption twice: `search_path` as a startup
parameter is not applied reliably by PgBouncer (a, b, a read as a, b, b), so schema moved to the role; and a
mid-query reset also kills an idle second connection, so a same-instant follow-up fails once (the test now waits for the
close to be seen, as the finding says).

**Changed files**

- `packages/store-postgres/spike/db-access/` (new): `budget.ts`, `pooler.ts`, `tcpProxy.ts`, `resilient.ts`, `tick.ts`,
  `fleetWorker.ts`, `fleetStats.ts`, the PgBouncer configs and `userlist.txt`, and `pooling`, `claimPath`, `failure`,
  `fleet`, `tls`, `tick` test files.
- `docker-compose.test.yml`: opt-in `pgbouncer` (56432, 56433) and `tls` (55433) profiles, and the main Postgres runs
  `max_connections=200`. `.gitignore`: `db-access/.tls/`. `CLAUDE.md`: how to start them and the `QCLOUD_REQUIRE_*` variables.
- No ported code changed, so `docs/PORTING.md` has no new rows.

**Verified**

- Gate with Postgres, ElasticMQ, the Pub/Sub emulator, PgBouncer and TLS all required (`QCLOUD_REQUIRE_*=1`):
  typecheck, lint, format, architecture and `bun test` pass, 88 tests in 18 files, 248 s.
- Verify command `bun run typecheck && bun test packages/store-postgres/spike`: run as part of the above.
- `bun test .../db-access/failure.test.ts` 3 times in a row after the one flake fix: 9 of 9 each time.
- `bun run test:model` not run: no core queue semantics changed.

**What was and was not run**

- **Created in a cloud account: nothing. Removed: nothing to remove.** No `gcloud`, `aws` or `terraform` call.
- Not run (D9): Cloud SQL and RDS over TLS, IAM auth, managed pooling, RDS Proxy pinning, HA failover timing, Cloud SQL's
  certificate against `Bun.SQL`'s hostname check, the measured fleet on a real instance (step 4), Cloud Tasks relay
  precision and cost, Cloud Scheduler jitter.
- Documented figures were read on 2026-10-13: Cloud SQL managed pooling, Cloud Tasks limits and price, RDS Proxy pinning.
  Others are listed in the write-up as not re-fetched.
- Restart behaviour is one probe (0 to 2 failed operations over 1 to 1.5 s), not a committed test.
- Latencies are loopback and single-machine. Read them as comparisons.
- Local roles and schemas created by the suites are dropped by them. Containers are left running for the next task.
- Nothing committed.

**Open for task 06**

- D1 (worker hosting): the in-process tick and its seconds-level precision only exist with always-on workers.
- Whether the Phase 1 sign-off needs a real Cloud SQL run for the TLS, IAM and failover questions above.
- Spike disposal: `budget.ts`, `resilient.ts` and `tick.ts` are candidates to promote (tasks 19, 20); the rest are tests
  and fixtures.
