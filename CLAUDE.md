# CLAUDE.md

Qelay-Cloud runs a Qelay-shaped job queue on managed cloud services (GCP first, then AWS). Postgres is the
authoritative job-state store; the cloud queue is only a "doorbell". Design: [DESIGN.md](DESIGN.md).

**Task tracking:** [.claude/.planning/v1.0.0/CURRENT.md](.claude/.planning/v1.0.0/CURRENT.md) lists every task, its
dependencies and status. Work them in order. A task is done when its Acceptance list is true and its Verify commands
were run, then fill in its **Result** section and update the status table. At task completion also write
`.claude/completions/YYYY-MM-DD-task-name.md`.

## Rules

- **English only** in code, comments, tests and docs.
- **Bugs:** write a failing test that reproduces it first, then fix. Changes to core queue semantics also run
  `bun run test:model`.
- **Ported code** from `../qelay` keeps the upstream MIT notice, and each ported file gets a row in
  [docs/PORTING.md](docs/PORTING.md). `../qelay` and `../qelay-control-panel` are read-only inputs: never edit them from here.
- **Real cloud resources** (`terraform apply`, `gcloud` or `aws` writes, anything paid or shared) need the user's
  explicit go-ahead. Use emulators and `terraform plan` otherwise, and state in the task Result what was and was not run.
- **No push, publish or version bump** without the user. Tasks end at a clean local gate.
- **Migrations are forward-only and safe with old workers connected.** Never edit a migration that has shipped: its
  checksum is recorded, and an edited one stops every process with `SchemaDriftError`. Add the next version instead.
  A migration may add a nullable column or a column with a default, add a table, or add an index. It must not drop,
  rename or retype anything the previous release still reads or writes; that takes two releases (stop using it, then
  remove it). Use `pg_advisory_xact_lock` only, never a session-level lock (pooler-safe). A schema change also
  regenerates `packages/store-postgres/test/schema.snapshot.txt` (`QCLOUD_UPDATE_SNAPSHOT=1`), which is reviewed as part
  of the change, and a new query path comes with a row in `schema.indexes.test.ts`.
- **Secrets** never go in the repo, test output or logs. Connection strings come from env or the cloud secret manager.
- A task that finds the design wrong stops and records it, in its Result and in task 06's gate (or DESIGN.md after 06).
  It does not silently deviate.

## Stack

Bun 1.4.2 (`.bun-version`), strict TypeScript, Oxlint and Oxfmt, `bun test`. Database driver is `Bun.SQL` (Bun-only).
Table prefix is `qcloud_*`, never `qelay_*`. Packages are consumed as TypeScript source (`exports` points at `src/`).
Files are capped at 300 lines.

## Gate

Run before marking any task done:

```bash
bun run typecheck && bun run lint && bun run format:check && bun run architecture && bun test
```

Tests that need Postgres use `test/support/db.ts` (one isolated schema per test file):

```bash
docker compose -f docker-compose.test.yml up -d --wait   # Postgres 16 on 127.0.0.1:55432, tmpfs
QCLOUD_REQUIRE_DB=1 bun test                              # fail, don't skip, if it is unreachable
docker compose -f docker-compose.test.yml down
```

Without `QCLOUD_REQUIRE_DB=1`, database suites are skipped with a warning when Postgres is down. That is fine for a
quick check, but any task that touches the store must run the gate with the database up and the variable set. CI does.
`QCLOUD_TEST_DATABASE_URL` overrides the default connection string.

`test:model` runs the StateStore model harness (`test/model/`).
- `QCLOUD_MODEL_RUNS` and `QCLOUD_MODEL_COMMANDS` deepen a run.
- `QCLOUD_MODEL_TARGET` picks the store.
- A failure prints the command that replays it.

The Pub/Sub transport suites (`packages/transport-gcp/test/`, and `test/contract/pubsub.test.ts`) need the Pub/Sub emulator
on `127.0.0.1:58085` (`QCLOUD_PUBSUB_EMULATOR_HOST` overrides it). Without it they skip with a warning, unless
`QCLOUD_REQUIRE_PUBSUB=1`. CI does not run it. Start it on the host with
`gcloud beta emulators pubsub start --host-port=127.0.0.1:58085 --project=qcloud-test` (gcloud components
`pubsub-emulator` and `beta`). The compose `pubsub` profile is untested. The fault scenarios (`delivery.test.ts`,
`crash.test.ts`) also need Postgres and take about 50 s together. Run the package with
`QCLOUD_REQUIRE_DB=1 QCLOUD_REQUIRE_PUBSUB=1 bun test packages/transport-gcp test/contract`. These tests only ever talk to the
emulator, never to Google Cloud.

The SQS transport suites (`packages/transport-aws/test/`, and `test/contract/sqs.test.ts`) need ElasticMQ on
`127.0.0.1:59324`: `docker compose -f docker-compose.test.yml --profile sqs up -d --wait sqs` (its config is
`test/support/elasticmq.conf`; any ElasticMQ 1.7 with `sqs-limits = strict` works, for example the JVM jar). Without it
the emulator suites skip with a warning, unless `QCLOUD_REQUIRE_SQS=1`. The stub-client suites (`names`, `publisher`,
`ring`, `stats`, `receive`, `deadLetters`) always run. The fault scenarios (`delivery`, `crash`, `delay`, `outage`,
`cost`) also need Postgres and take about 2 minutes together. Run the package with
`QCLOUD_REQUIRE_DB=1 QCLOUD_REQUIRE_SQS=1 bun test packages/transport-aws test/contract`. Every result from ElasticMQ is
an "emulator" result, never a "real" one: [docs/limits.md](docs/limits.md) section 9 lists where they differ.
`bun scripts/sqs-fidelity.ts` probes those differences, against the emulator by default and against a real account with
`--real --region <r>` (needs the user's go-ahead). CI does not run ElasticMQ.

The connection suites (`packages/store-postgres/test/connection.*.test.ts`) need only Postgres, apart from two opt-in
services, and CI runs the ones that need nothing more (`budget`, `target`, `options`, `driver`, `fault`, `socket`):

- PgBouncer in transaction mode, for `connection.pooler` and `connection.pooled` (which also claims and completes
  through it) and for `packages/maintenance/test/pooled.test.ts` (the tick lease behind a pooler):
  `docker compose -f docker-compose.test.yml --profile pgbouncer up -d --wait pgbouncer pgbouncer-noprep` (ports 56432
  and 56433; its config is in `test/support/pgbouncer/`). They skip with a warning without it, unless
  `QCLOUD_REQUIRE_PGBOUNCER=1`.
- A TLS Postgres, for `connection.tls`:
  `docker compose -f docker-compose.test.yml --profile tls up -d --wait postgres-tls` (port 55433, a throwaway
  certificate exported to the gitignored `test/support/pgbouncer/.tls/`). Skips without it, unless `QCLOUD_REQUIRE_TLS=1`.

The maintenance suites (`packages/maintenance/test/`) run on Postgres alone. `election.test.ts` spawns three `bun`
processes on real timers (about 7 s), `chaos.test.ts` (about 21 s) and `lateness.test.ts` (about 4 s) run on real timers
too, and `bun run scripts/measure-tick-lateness.ts` prints the lateness table that `docs/limits.md` (task 22) is to
quote. `pooled.test.ts` needs PgBouncer (the `pgbouncer` profile above).

`check:terraform` (task 21) plans `infra/gcp/example` without credentials (placeholder token, every `GOOGLE_*` variable dropped)
and asserts the plan: roles, database safety, Pub/Sub names against `packages/transport-gcp`, the connection budget against
`budget()`. It needs `terraform` 1.5 or later; without it the check is skipped with a warning, unless
`QCLOUD_REQUIRE_TERRAFORM=1` (CI sets it). It is not part of the gate. Run it after any change under `infra/`. Never run
`terraform apply` or `destroy` from here without the user's go-ahead.

`test:contract` and `test:scenarios` (task 41) run the one contract suite and the one scenario set against each transport:
`bun run test:contract --transport=local,gcp-emulator,aws-emulator` (the default is every emulator name), and the same for
`test:scenarios`. `local` is the memory and Postgres transports and needs Postgres only; `gcp-emulator` needs the Pub/Sub
emulator and `aws-emulator` ElasticMQ, as above, and a transport that is down fails the run (the script sets
`QCLOUD_REQUIRE_*`). `gcp` and `aws` mean the real clouds and are refused unless `QCLOUD_REAL_CLOUD=1`, which is the
owner's go-ahead (D9); no real-cloud stack exists before task 43. `docs/transports.md` is generated: after a change to
a capability, a skip or a matrix row, run `bun run docs:transports` (`test/contract/matrix.test.ts` fails otherwise).
`bun run architecture` also fails when `core`, `sdk`, `store-postgres`, `maintenance` or `control-api` imports a broker
package or names a broker kind: a difference between brokers is a capability, and `packages/transports` is the one
place that turns a configured name into a transport.
