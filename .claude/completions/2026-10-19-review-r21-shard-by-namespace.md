# R21: shard by namespace across databases

Date: 2026-10-19. Tracker: `.claude/.planning/review-2026-10-19/CURRENT.md`.

## What changed

- **`ShardMap`** (`packages/store-postgres/src/connection/shards.ts`): namespace → shard name → database options. Explicit, not
  hashed. From the environment: `QCLOUD_SHARDS=ns=shard,...`, with `QCLOUD_SHARD_<NAME>_DATABASE_*` over the shared
  `QCLOUD_DATABASE_*` for that shard. A shard's variables are read only when that shard is opened, so a process holds one
  shard's URL. `QCLOUD_DATABASE_URL` beside a map, a malformed or duplicate entry, a bad shard name and a namespace outside the
  map are refused (`UnsupportedOptionError`), and no message repeats a URL. `databaseOptionsForNamespace` is the one call the
  API and the tick use.
- **SDK:** `QueueOptions.shards`. A queue opens its namespace's shard. `shards` conflicts with `databaseUrl`, `database` and `store`.
- **Control API:** `QCLOUD_NAMESPACE` picks the shard; `qcloud-api migrate` migrates every shard in turn, names each in its output,
  stops at the first failure (exit 1) and names it.
- **Tick:** `QCLOUD_SHARD=a qcloud-tick loop` runs one `TickLoop` per namespace of the shard over one pool (`shardLoop.ts`),
  closes the pool and each transport once. `run`, `serve`, `send` and `webhook-writer` refuse it.
- **Redaction:** the shard URL variables (`SHARD_SECRET_VARIABLE`) are scrubbed from the tick's log like the shared ones.
- **Docs:** DESIGN.md (D10 and "Shards"), `docs/limits.md` section 14, `docs/operations.md` "Shards",
  `docs/reference/configuration.md` (three rows), `docs/known-issues.md` row 11.
- No migration, no schema change, no change to core queue semantics.

## Verify

- New tests: `connection.shards.test.ts` (6), `queue.shards.test.ts` (2), `runtime.shards.test.ts` (2), `cli.shards.test.ts` (5),
  and one shard-URL case in `redact.test.ts`. Two schemas of one test database stand in for two databases.
- store-postgres, sdk, control-api and maintenance on scratch PostgreSQL 18.6: 3021 pass, 23 skip (PgBouncer, TLS), 0 fail.
- `typecheck`, `lint` (only the existing panel warnings), `format:check` and `architecture` pass.
- `test:model` not run for this task: no core queue code changed.

## Not done / owed

- **One namespace per API process.** There is no request-time router: it needs the namespace in the URL and the authorization
  model, and the panel to follow. The map only picks that process's database.
- **Webhook `send`, `run`, `serve` and `webhook-writer` are per namespace** too.
- **Moving a namespace is manual and untested** (copy its rows, edit the map).
- **No cross-shard reads, no Terraform for several databases**, and one namespace cannot be split (the journal lock is per
  namespace). The connection budget is per shard.
- **Not run on two real database servers and not measured under load.** PostgreSQL 16 and Docker are owed with the rest.
