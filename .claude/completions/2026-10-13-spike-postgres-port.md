# Task 01: spike, port inventory and broker coupling (2026-10-13)

**Done.** The verdict is **go on "port"**. The upstream Postgres hot path runs without brokers after small hand edits.

- **Ported:** qelay `c43442c9` (schema 21), via its import closure. That is 70 files and 10,137 upstream lines.
- **Kept:** 98.1% of lines needed nothing beyond the `bunqueue` → `qcloud` rename.
  - 16 lines were adapted, 180 dropped (112 of them `brokerSessions.ts`), 3 added and 0 rewritten.
- **Fence:** brokers are replaced by `lease_token` plus an unexpired `lease_until`, checked under a row lock.
  - `version` compare-and-set is for writers without a lease.
- **Inventory:** all 86 modules have a verdict (52 keep, 28 adapt, 4 drop, 2 rewrite).
  - The 2 rewrites are `runtime` (the tick, in task 20) and `store` (the `StateStore` facade, in tasks 12-15).
- **Docs:**
  - the write-up, with the module plan for tasks 11-15: `docs/spikes/01-postgres-port.md`;
  - the full Result: `.claude/.planning/v1.0.0/01-spike-postgres-port.md`;
  - 72 new rows in `docs/PORTING.md`.

**Checked.** The spike tests pass on 6 consecutive runs:

- 1,000 jobs across 8 claimers are each claimed exactly once. The latest run took about 1.8 s.
- A SIGKILLed claimer's lease expires and its token is rejected. The job is then recovered with `attempts` 1 and reclaimed.
- A job that fails twice dead-letters exactly once.

The full gate passes with the test Postgres up and `QCLOUD_REQUIRE_DB=1`: 6 tests across 3 files.

**Not done / not verified:**

- no cloud resources;
- no TLS to a managed database (task 05);
- no model harness (task 02);
- no concurrency testing of groups, limits, flows or cron.

Docker Desktop was started locally for the test database. Nothing was committed.

**Open for the user** (also recorded in task 06's gate):

- **DESIGN.md invariant 2.** It needs a wording clarification on lease-holder fencing; this is not a design change.
- **Task 13 corrections.**
  - Claim does not increment `attempts` upstream.
  - `sessionLimits.ts` is not a broker module, so it should be kept.
- **Event journal.** The recommendation is to keep it in task 11.

**Next:** task 02 (StateStore model-test harness). Task 01 also unblocks 03, 04 and 05.
