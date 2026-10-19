# R10: fewer bells (review F3, F10)

Date: 2026-10-19. Tracker: `.claude/.planning/review-2026-10-19/CURRENT.md`.

## What changed

- `packages/sdk/src/workerPump.ts` (new): the worker's claims. A bell starts one; a full claim is followed by more as slots free
  up. `claimAgain` (worker option, default true) turns it off. A run that wrote no outcome does not trigger a claim.
- `packages/store-postgres/src/store/ringCover.ts` (new): `ringCoverMs`, opt-in. One probe per queue; the job is stored as
  rung at the covering bell's time. `QueueOptions.ringCoverMs`, `StoreSource`, `StoreContext`.
- `ringQuery.ts`, `tick.ts`, `core/jobs.ts`, `maintenance/config.ts`, `env.ts`: `maxStaleRingsPerQueue`.
- Docs: DESIGN.md (the tick), limits.md, known-issues.md, compat.md, configuration.md, the gate document.

## Verify

- `bun run test:model` 31 pass, default and `QCLOUD_MODEL_RUNS=150 QCLOUD_MODEL_COMMANDS=60`.
- `bun test ./packages/sdk` 245 pass; store, maintenance and core suites pass (2114 + the one fix below).
- Contract and scenarios against local, Pub/Sub emulator and ElasticMQ: no failures.
- `docs:check` passes (after `--write` for the generated unsupported list).

## Not done / owed

Real-cloud bell counts (D9, F17). Defaults for cover and the stale cap stay off.
