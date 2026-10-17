# 02 — StateStore model-test harness

**Status:** done · **Depends on:** 00 · **Phase:** 0

## Goal

Build the correctness gate for the store before the store exists: a `fast-check` model that generates command histories and
checks the five invariants from DESIGN.md section 3. Qelay does the same against a TCP broker plus SQLite; this one runs against `StateStore` directly.

## Scope

In: the harness, the reference model, the invariant checks, and a fake in-memory `StateStore` used only to prove the harness
catches bugs. Wired to `bun run test:model`.
Out: the real store (tasks 11-15). Those tasks turn the harness on.

## Reference

Upstream model tests: `../qelay/test/model-based/` (`queue-model.test.ts`, `flow-producer-model.test.ts`,
`workflow-model.test.ts`) and the `repro-model-*.test.ts` regressions in `../qelay/test/`. Read these first to reuse the command
vocabulary and shrinking approach; do not copy the broker and `SIGKILL` parts.

## Steps

1. Define the command set: `enqueue`, `enqueueDelayed`, `claim`, `heartbeat`, `complete`, `fail`, `advanceClock`, `expireLease`, `pause`/`resume`,
   `promote`, `changePriority`, `cancel`, `tick`, `crash` (drop a worker's lease without telling the store).
2. Write the reference model (a plain in-memory state machine) with explicit legal transitions between
   `waiting`, `prioritized`, `delayed`, `waiting-children`, `active`, `completed`, `failed`.
3. Encode the invariants as checks run after every command:
   1. no loss and no resurrection (a terminal job never becomes active again);
   2. no job active under two live leases; a stale `lease_token` can never complete a job;
   3. no claimable job stays unclaimed past one tick;
   4. retries never exceed `max_attempts`, and an expired lease counts as an attempt;
   5. DLQ entry written exactly once per exhausted job.
4. Ordering checks: priority, FIFO, LIFO, and delay order match the model.
5. Add a **fault-injection** layer: drop the publish step, deliver a doorbell twice, deliver it late. The invariants must still hold.
6. Make the harness take a `StateStore` factory so any implementation, fake or real, plugs in. Seeds, minimised histories and a replay path are printed on failure.
7. Prove it works: run it against the fake store, then introduce three deliberate bugs (double-claim, lost completion, attempt not counted) and show the harness fails each.

## Acceptance

- `bun run test:model` passes on the fake store and fails on each of the three planted bugs, with a minimised, replayable history.
- A failing run prints the seed and the exact replay command (`QCLOUD_MODEL_SEED=... bun run test:model`).
- The five invariants each map to at least one named check.
- Run counts are configurable (`QCLOUD_MODEL_RUNS`, `QCLOUD_MODEL_COMMANDS`), with a small default for the gate and a large setting for deep runs.

## Verify

```bash
bun run test:model
QCLOUD_MODEL_RUNS=500 QCLOUD_MODEL_COMMANDS=150 bun run test:model
```

## Risks / notes

- A model that mirrors the implementation proves nothing. Write the model from the legal-transition rules and the invariants, not from the store code.
- Never weaken an invariant to make a run green (Qelay's rule). If the store is wrong, add a deterministic `test/repro-model-*.test.ts` first.
- The `crash` command is the one that finds real bugs; do not omit it because it is hard to model.

## Result

Done 2026-10-13. `bun run test:model` runs a `fast-check` model harness against any `StateStore` factory. It passes on
the fake store and catches every planted bug with a short, replayable history.

**Built.** All new code is in `test/model/` (14 files, 1,923 lines, none over 300). `fast-check` was added as a dev dependency.

- `store.ts`: the provisional `StateStore` contract the harness drives. Task 10 replaces it with core's.
- `model.ts`, `reference.ts`: the reference model.
  - The seven states and a cause-by-cause transition table (`TRANSITIONS`).
  - The claim-order rule.
  - `QueueModel`, written from the rules and not from the fake store.
- `transport.ts`: a virtual clock and a doorbell transport with faults (`drop`, `duplicate`, `late`).
- `world.ts`, `invariants.ts`: the named checks and the code that runs them after every command.
- `command.ts`, `commands-jobs.ts`, `commands-ops.ts`, `commands.ts`: the commands and their generators.
  - The 14 from Step 1.
  - Plus `zombie` (a crashed or finished worker reuses its lease) and `deliverLate` (flushes late doorbells).
- `fakeStore.ts`, `targets.ts`: the in-memory store and five planted bugs.
  - The three required: double-claim, lost completion, attempt not counted.
  - Two extra: no re-ring on tick, and a DLQ entry that outlives a retired custom id.
- `run.ts`, `store-model.test.ts`: the runner, failure report, env settings and the meta-tests.

**Named checks.** Each invariant maps to at least one check, and `world.ts` (`CHECKS`) describes each check.

| Invariant | Checks |
| --- | --- |
| 1. No loss, no resurrection | `I1.noLoss`, `I1.noResurrection` |
| 2. One live lease; stale token rejected | `I2.singleLiveLease`, `I2.staleTokenRejected` |
| 3. Nothing stuck past a tick | `I3.nothingStuck` |
| 4. Attempts bounded and counted on lease expiry | `I4.attemptsCounted`, `I4.attemptsBounded` |
| 5. DLQ exactly once | `I5.dlqExactlyOnce` |

Other checks:

- ordering: `ORDER.priority`, `ORDER.lifo`, `ORDER.fifo`, `ORDER.delay`;
- claims: `CLAIM.count`, `CLAIM.paused`;
- transitions: `T.legalTransition`;
- the model's own consistency: `MODEL.state`, `MODEL.outcome`.

A target can turn on a subset of commands and checks, so tasks 12-15 can enable the harness one piece at a time.

**Planted bugs.** Each is caught by the check it should hit:

| Bug | Check | Example minimised history |
| --- | --- | --- |
| double-claim | `I2.singleLiveLease` | enqueue with a duplicated ring, then two claims (3 commands) |
| lost-completion | `I1.noResurrection` | enqueue, claim, heartbeat, complete (4) |
| attempt-not-counted | `I4.attemptsCounted` | enqueue, claim, expireLease, tick (4) |
| no-re-ring | `I3.nothingStuck` | 2 commands |
| stale-dlq | `I5.dlqExactlyOnce` | 4-6 commands |

The meta-tests use a fixed seed (1,000 runs, up to 60 commands each). They check that every bug fails the expected check
within 8 commands, and that replaying with the printed seed and path gives the same check and history. On top of that, a
one-off probe ran 30 seeds per bug. All 150 found the bug with the right check, and the longest history was 6 commands.

**Failure report.** It prints:

- the check;
- the seed;
- the numbered minimised history;
- `QCLOUD_MODEL_SEED=<seed> [QCLOUD_MODEL_TARGET=<bug>] bun run test:model`, which re-runs and shrinks to the same history;
- the same command plus `QCLOUD_MODEL_PATH` and `QCLOUD_MODEL_REPLAY_PATH`, which runs only the minimised history.

Settings come from `QCLOUD_MODEL_TARGET`, `QCLOUD_MODEL_RUNS` (default 100) and `QCLOUD_MODEL_COMMANDS` (default 60).

**Verify.** All of these were run:

- `bun run test:model`: 6 pass, about 65 ms.
- `QCLOUD_MODEL_RUNS=500 QCLOUD_MODEL_COMMANDS=150 bun run test:model`: 6 pass, about 170 ms.
- `QCLOUD_MODEL_TARGET=<bug> bun run test:model` for double-claim, lost-completion and attempt-not-counted. Each exits 1
  with the seed and both replay commands.
  - All six printed commands were run, and each reproduced the same check and history.
- The full gate, with the test Postgres up and `QCLOUD_REQUIRE_DB=1`: 12 tests across 4 files pass.

**Modelling decisions:**

- **Attempts.** A claim does not count an attempt; fail and lease recovery do. This follows upstream and task 01 finding 2.
- **Backoff.** It is 0 in the harness, because upstream's backoff jitter (`Math.random`) would make replays nondeterministic.
- **Custom ids.**
  - Re-enqueueing a live id deduplicates.
  - Re-enqueueing a completed or failed id deletes that generation, DLQ entry included, and admits a new one.
  - This matches upstream's `deleteTerminalGeneration`, where the DLQ entry is the `dlq_entry` column on the job row.
- **Transport** behaves like Pub/Sub:
  - delivery order is not guaranteed;
  - any pending doorbell can be delivered;
  - the store returns doorbells and the caller rings them.
- **Tick.** It recovers expired leases, then re-rings claimable jobs in unpaused queues whose last ring is at least
  `reRingAfterMs` old (10 s, equal to the tick interval).
- **Stall limit** is not modelled. With `maxAttempts <= 3`, the attempt limit always fires first.

**Findings recorded for task 06.** They are listed in its "Inputs recorded by earlier tasks" section:

1. The harness has run only against the fake store. DESIGN.md Phase 0 (a) expects the model test to run against the
   ported Postgres code. That needs an adapter and a clock seam (see 2), which the plan puts in tasks 11-15. Task 06
   decides whether Phase 0 needs it first.
2. **Clock seam.** The Postgres store reads `databaseNow(tx)`. It needs an injectable clock to run under the harness, so `tick()` takes no `now`.
3. **Interface changes for Step 4.** Mutations that make a job claimable return doorbells (enqueue, fail-retry, promote,
   tick). See the header of `test/model/store.ts`.
4. **Deterministic retries.** Tasks 13 and 14 need injectable randomness or a deterministic backoff, or model runs with
   backoff above 0 cannot be replayed.
5. **Re-ring contract.** `rung_at` is set when a ring is issued. The tick re-rings claimable jobs whose `rung_at` is null or
   at least `reRingAfterMs` old, with the threshold no larger than the tick interval, and skips paused queues. Without this,
   a dropped publish leaves a job stuck (the `no-re-ring` bug).
6. **Generated ids** must sort in creation order, as UUIDv7 does, or LIFO order cannot be told apart from id order.
7. Upstream's model test uses `endOnFailure: true`, which turns off shrinking. This harness does not.

**Not run:**

- no real store (none exists yet);
- no Postgres target;
- no cloud resources;
- no commit or push.

`../qelay` was only read.
