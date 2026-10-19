# R17: one-second TickLoop worker (review F11)

Date: 2026-10-19. Tracker: `.claude/.planning/review-2026-10-19/CURRENT.md`.

## What changed

- `qcloud-tick loop` (`packages/maintenance/src/cli.ts`): the existing `TickLoop` as a long-running process. Defaults where the
  environment is silent: interval 1,000 ms, `maxStaleRingsPerQueue` 10, upkeep every 30 s. It runs until SIGTERM and gives the
  lease up on the way out. Same environment as `serve`, minus the audience settings.
- Upkeep split: `TickBudget.skipUpkeep` (core) leaves out the retention, events and completions steps of `store.tick`
  (`store/tick.ts`, the three blocks are now one list). `TickOptions.upkeepEveryMs` and `QCLOUD_TICK_UPKEEP_EVERY_MS` (default 0,
  every beat) set how often a `TickLoop` runs them; the time is kept per process (`loop.ts`, `#upkeptAt`). Recovery, crons,
  promotion, expiry and the ring query run on every beat.
- `tickOptionsFromEnv` and `settingsFromEnv` take the defaults to apply (the scheduler's minute for `run` and `serve`).
- Tests: `loop.upkeep.test.ts` (3 beats by default, with a long and a short `upkeepEveryMs`), `cli.loop.test.ts` (defaults,
  lease length, release on stop, bad setting), a `skipUpkeep` case in `tick.compose.test.ts`.
- Docs: `reference/configuration.md` (new row), `limits.md` (config rows, the always-on bullet), `concepts.md`, `operations.md`,
  `DESIGN.md`.

## Verify (scratch PostgreSQL 18.6)

- `loop.upkeep`, `cli.loop`, `env` tests, `tick.compose.test.ts` (17) and the whole maintenance package (397 pass, 1 skip: PgBouncer).
- typecheck, lint (panel warnings only), format:check, architecture (1539 files within 300 lines), `docs:check` clean.

## Not done / owed

Terraform for an always-on loop service (R19). A health endpoint for the loop process. The cost of a beat on a real
Cloud SQL or RDS database (the lease is one write per beat) and the cron firing time at one second. The scheduler tick stays
as the safety net and the cron source; the loop does not replace it.
