# Task 02: StateStore model-test harness (2026-10-13)

**Done.** `bun run test:model` runs a `fast-check` model harness against any `StateStore` factory.

- The commands are enqueue, claim, heartbeat, complete, fail, crash, lease expiry, tick, pause/resume, promote, priority change and cancel.
- After every command, the harness checks invariants 1-5 and the ordering rules.
- Doorbells can be dropped, duplicated or delivered late.
- **Code:** `test/model/` (14 files, 1,923 lines) and the `fast-check` dev dependency.
- **Checks:** the five invariants map to `I1.noLoss`, `I1.noResurrection`, `I2.singleLiveLease`,
  `I2.staleTokenRejected`, `I3.nothingStuck`, `I4.attemptsCounted`, `I4.attemptsBounded` and `I5.dlqExactlyOnce`.
  - Further checks cover ordering, claim count, paused queues and legal transitions.
- **Proof:** it passes on a fake in-memory store. It catches five planted bugs with the check each should hit:
  - double-claim;
  - lost completion;
  - attempt not counted;
  - no re-ring;
  - stale DLQ entry.

  Each has a minimised history of 2-6 commands, and this held for all 30 seeds tried per bug.
- **Failure report:** it prints the seed, the history and `QCLOUD_MODEL_SEED=... bun run test:model`, plus a
  path replay that runs only the minimised history. Every printed command was re-run and reproduced its failure.

**Checked.** All of these pass:

- `bun run test:model` (about 65 ms);
- `QCLOUD_MODEL_RUNS=500 QCLOUD_MODEL_COMMANDS=150 bun run test:model` (about 170 ms);
- the full gate with the test Postgres up and `QCLOUD_REQUIRE_DB=1` (12 tests, 4 files).

**Also changed:**

- CLAUDE.md no longer calls `test:model` a placeholder.
- The `02-store-model-harness.md` Result is filled in.
- The CURRENT.md status table is updated.
- Findings are added to task 06's inputs.

**Not done / not verified:**

- no real or Postgres store has run under the harness (tasks 11-15);
- no cloud resources;
- nothing committed.

**Open for task 06:**

- DESIGN.md Phase 0 (a) expects the model test against the ported Postgres code. Decide whether that happens before Phase 1.
- The `StateStore` sketch changes: an injected clock, and mutations that return doorbells.
- The tick's re-ring contract.
- Deterministic backoff for replayable runs.
- Generated ids must sort by creation (UUIDv7).

**Next:** task 03 (Pub/Sub doorbell spike). Its emulator steps can run now; the real-project step needs D9.
