# Task 10: core types, state machine, interfaces (2026-10-14)

**Done locally.** `packages/core` holds the job vocabulary, the transition table as data, `StateStore` and
`DeliveryTransport` as settled at the Phase 0 gate, typed errors, option validation and the clock seams. It has no
runtime dependencies. Task 06's step 9 was taken as given by the user's "continue through the remaining tasks".

**Changed files**

- `packages/core/src/`: `jobs.ts`, `transitions.ts`, `store.ts`, `transport.ts`, `errors.ts`, `options.ts`, `clock.ts`,
  `codec.ts`, `index.ts`, and three test files.
- `test/model/`: `store.ts` (now a re-export of core), `model.ts` (table from core), `fakeStore.ts`, `fakeRows.ts` (new),
  `world.ts`, `commands-jobs.ts`, `commands-ops.ts`, `command.ts`, `targets.ts`.
- `package.json` (workspace link for `@qelay-cloud/core`), `bun.lock`.
- `.claude/.planning/v1.0.0/`: `CURRENT.md`, `06-phase0-gate.md`, `10-core-types-and-interfaces.md`.
- `docs/spikes/06-phase0-gate.md`: an Amendments section.

**Checked**

- `bun test packages/core`: 16 pass. `bun run test:model`: 6 pass, five planted bugs still caught.
- typecheck, oxlint, oxfmt and the 300-line architecture check clean.
- `QCLOUD_REQUIRE_DB=1 bun test` with every emulator reachable: 104 pass, 0 fail, 21 files.

**Not done / not verified**

- The model harness has only run against the fake store. Postgres plus the clock seam is task 11 onwards (condition 1).
- Nothing committed or pushed (the repository has no commits).

**Next:** task 11 (Postgres schema, migration runner, connection factory).
