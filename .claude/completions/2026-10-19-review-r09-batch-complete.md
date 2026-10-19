# R09: batch complete and lighter metrics (2026-10-19)

Review finding F4. Result and decisions are in `.claude/.planning/review-2026-10-19/CURRENT.md`.

## Changed
- `packages/core/src/store.ts`: `completeMany` on `StateStore`.
- `packages/store-postgres/src/store/{complete,jobRow,metricRetention,metrics,throughput,tick}.ts`, `postgresStore.ts`.
- `packages/sdk/src/{groupComplete,groupCommit,runtime,workerOptions,worker,jobRunner}.ts`: the `groupComplete` worker option.
- `test/model/*`: a `completeMany` command (Postgres and fake store).
- Docs: `limits.md` (item 3), `observability.md`, `compat.md`, `unsupported.md` (generated), `operations.md`, `PORTING.md`.

## Verified (local Postgres 18.6, no Docker)
- `bun run typecheck`, `lint` (no errors; panel warnings were there before), `format:check`, `architecture`, `docs:check --no-run`.
- `bun test` on SDK (260), the store suites that touch metrics, plans and schema (297), maintenance tick suites.
- `bun run test:model` at default depth and at `QCLOUD_MODEL_RUNS=150 QCLOUD_MODEL_COMMANDS=60`: 31 pass each.

## Not run
- The full gate, Postgres 16 and the load check on a managed database (owed at the end).
