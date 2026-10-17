# Contributing

How to build, test and change Qelay-Cloud. Read [docs/architecture.md](docs/architecture.md) first; the decisions behind
it are in [DESIGN.md](DESIGN.md).

## Set up

You need [Bun](https://bun.sh) 1.4.2 (the version in `.bun-version`; `bun --version` should match) and a Postgres.

> Not run: it changes your checkout and needs the network.

```bash notrun
bun install
```

The stack is strict TypeScript, Oxlint and Oxfmt, and `bun test`. The database driver is `Bun.SQL`, so the code runs on Bun
only. Packages are consumed as TypeScript source (`exports` points at `src/`). Tables are named `qcloud_*`, never
`qelay_*`. A file is at most 300 lines.

## The gate

Run this before you propose a change:

> Not run: it needs your Postgres, and takes minutes.

```bash notrun
bun run typecheck && bun run lint && bun run format:check && bun run architecture && bun test
```

`bun run format` fixes formatting. `bun run architecture` checks the file size cap and the two boundary rules in
[architecture.md](docs/architecture.md#rules-the-build-enforces).

If you changed anything under `docs/`, `README.md`, `CONTRIBUTING.md` or `examples/`, also run `bun run docs:check`
([Documentation](#documentation)). If you changed `infra/`, run `bun run check:terraform`.

## Test services

Tests that need Postgres use one isolated schema per test file (`test/support/db.ts`).

> Not run: it starts containers.

```bash notrun
docker compose -f docker-compose.test.yml up -d --wait     # Postgres 16 on 127.0.0.1:55432
QCLOUD_REQUIRE_DB=1 bun test
docker compose -f docker-compose.test.yml down
```

`QCLOUD_TEST_DATABASE_URL` points the tests at another Postgres. Without `QCLOUD_REQUIRE_DB=1`, database suites skip with a
warning when Postgres is down; CI sets it, and so should you before you say a change to the store is done.

Some suites need more, and skip with a warning when it is missing unless their `QCLOUD_REQUIRE_*` variable is set:

| Suites | Needs | Require variable |
| --- | --- | --- |
| Pub/Sub transport, `test/contract/pubsub` | The Pub/Sub emulator on `127.0.0.1:58085` (`gcloud beta emulators pubsub start --host-port=127.0.0.1:58085 --project=qcloud-test`) | `QCLOUD_REQUIRE_PUBSUB` |
| SQS transport, `test/contract/sqs` | ElasticMQ on `127.0.0.1:59324` (`docker compose -f docker-compose.test.yml --profile sqs up -d --wait sqs`) | `QCLOUD_REQUIRE_SQS` |
| Connection suites behind a pooler | PgBouncer (`--profile pgbouncer`, ports 56432 and 56433) | `QCLOUD_REQUIRE_PGBOUNCER` |
| Connection suite over TLS | A TLS Postgres (`--profile tls`, port 55433) | `QCLOUD_REQUIRE_TLS` |
| `check:terraform` | `terraform` 1.5 or later | `QCLOUD_REQUIRE_TERRAFORM` |

The emulator suites only ever talk to the emulator. CI runs Postgres and Terraform, not the emulators. An emulator result is
an "emulator" result, never a "real" one: [limits.md](docs/limits.md#9-emulator-gaps-worth-knowing) lists where they
differ.

`bun run test:contract` and `bun run test:scenarios` run the one transport contract and the one scenario set against each
transport (`--transport=local,gcp-emulator,aws-emulator`). The real clouds (`gcp`, `aws`) are refused unless
`QCLOUD_REAL_CLOUD=1`, which is the owner's go-ahead because it spends money.

### Model tests

`bun run test:model` runs a generated sequence of operations against the store and compares it with a simple model. A change
to the core queue semantics (claim, lease, retry, the DLQ, flows) runs it. A failure prints the command that replays it, with
`QCLOUD_MODEL_SEED`. `QCLOUD_MODEL_RUNS` and `QCLOUD_MODEL_COMMANDS` deepen a run; the flow and workflow models take the same
settings with `FLOW` and `WORKFLOW` in the name.

### Variables that only tests and scripts read

The settings of the product are in [docs/reference/configuration.md](docs/reference/configuration.md). These are not
settings; they belong to the test tools.

| Variable | Used by |
| --- | --- |
| `QCLOUD_TEST_DATABASE_URL` | Every database suite, `docs:check`, the smoke scripts. |
| `QCLOUD_REQUIRE_DB`, `_PUBSUB`, `_SQS`, `_PGBOUNCER`, `_TLS`, `_TERRAFORM` | Turn a skipped suite into a failure. |
| `QCLOUD_PUBSUB_EMULATOR_HOST`, `QCLOUD_SQS_ENDPOINT` | Where the emulators are. |
| `QCLOUD_MODEL_RUNS`, `_COMMANDS`, `_TARGET`, `_SEED`, `_PATH`, `_REPLAY_PATH` | The store model; `QCLOUD_FLOW_MODEL_*`, `QCLOUD_WORKFLOW_MODEL_*` and `QCLOUD_WFMODEL_*` are the same for flows and workflows. |
| `QCLOUD_FLOW_COVERAGE`, `QCLOUD_WORKFLOW_COVERAGE` | Print how often each rule was reached. |
| `QCLOUD_SCENARIO_SUITE`, `QCLOUD_SCENARIO_TRANSPORTS` | Choose scenarios and transports. |
| `QCLOUD_REAL_CLOUD` | Allow the contract and scenario runs against a real cloud. |
| `QCLOUD_UPDATE_SNAPSHOT` | Rewrite `packages/store-postgres/test/schema.snapshot.txt`. |
| `QCLOUD_PRINT_PLANS` | Print the `EXPLAIN` plan of the queries whose name contains the text. |
| `QCLOUD_WEBHOOK_COST_JOBS`, `QCLOUD_JOURNAL_COST_JOBS` | Size of the cost tests. |
| `QCLOUD_SMOKE_TOKEN`, `QCLOUD_SMOKE_DATABASE_URL` | The deployment smoke scripts. |
| `QCLOUD_DOCS_TIMEOUT_MS` | The time `docs:check` gives each documentation script. |

## Documentation

`bun run docs:check` is part of CI. It regenerates `docs/unsupported.md`, `docs/reference/routes.md` and
`docs/reference/sdk-exports.md` and fails when they changed (`bun run docs:check --write` rewrites them), checks relative
links and anchors, checks that every `QCLOUD_*` variable the code reads is in the configuration reference and the reverse,
checks that the imports in `ts` blocks resolve to real exports, and runs the `bash test` blocks of the quickstarts against a
throwaway database.

- A shell block in a quickstart is `bash test` (it runs) or `bash notrun`. A `notrun` block has a `> Not run: <reason>`
  line above it, under the same heading. The reason is shown to the reader; make it true.
- Ports 8080 and 8081 must be free when the quickstart runs.
- `bun run docs:transports` regenerates `docs/transports.md` after a change to a capability or a contract skip.
- English only, in code, comments, tests and docs.

## Rules for changes

- **A bug starts with a failing test** that reproduces it. Then fix it.
- **Migrations are forward-only and safe with the previous release connected.** Never edit a migration that has shipped: its
  checksum is recorded, and an edited one stops every process with `SchemaDriftError`. Add the next version. A migration may
  add a nullable column or a column with a default, a table, or an index. It must not drop, rename or retype anything the
  previous release still reads or writes; that takes two releases. Take a lock with `pg_advisory_xact_lock` only, never a
  session-level lock, so that it works behind a pooler. A schema change regenerates the snapshot
  (`QCLOUD_UPDATE_SNAPSHOT=1 bun test packages/store-postgres`), which is reviewed with the change, and a new query path
  adds a row to `schema.indexes.test.ts`.
- **A broker difference is a capability.** `core`, `sdk`, `store-postgres`, `maintenance` and `control-api` never import a
  broker package or branch on a broker kind. Add a field to the transport's `capabilities` and a contract test.
- **Ported code** from [Qelay](https://github.com/ChxisB/qelay) keeps the upstream MIT notice (see [LICENSE](LICENSE)), and
  each ported file gets a row in [docs/PORTING.md](docs/PORTING.md) in the same change.
- **Secrets never go in the repository, in test output or in logs.** Connection strings come from the environment or the
  cloud's secret manager.
- **Real cloud resources need the owner's go-ahead**: `terraform apply`, any write with `gcloud` or `aws`, anything paid or
  shared. Use the emulators and `terraform plan` otherwise.
- **An unsupported feature fails loudly.** It throws `UnsupportedOptionError` naming the option or answers `501`; it is also a
  row in [compat.md](docs/compat.md). Never accept an option and ignore it.

## Adding a transport

The contract suite is the specification. A new broker is a package `packages/transport-<name>` that implements
`DeliveryTransport` from `core` and declares its `capabilities` (the largest delay it holds, the largest ring batch, whether
it counts deliveries, how fine its retry delay is). Then:

1. Run `describeTransportContract` (`test/contract/transport.ts`) against it, as `test/contract/pubsub.test.ts` does. A
   behaviour the broker cannot give is a declared capability or a `skips` entry with a reason; it is never a weaker
   assertion.
2. Add its name to `packages/transports` (`settings.ts`, `open.ts`) and to the stacks in `test/support/transports.ts`, so
   `test:contract` and `test:scenarios` run it. Nothing above `packages/transports` may name the broker.
3. Run `bun run docs:transports`; `docs/transports.md` is generated from the capabilities and skips.
4. Add the fault scenarios (a crash between claim and ack, a delayed bell, an outage) as `packages/transport-aws/test/` does.
   Say in `docs/limits.md` which results are from an emulator.

## Layout

```
packages/        the code: core, store-postgres, transport-*, transports, sdk, maintenance, control-api, panel
infra/           Terraform for GCP and AWS, each with a data plane and a control plane
examples/orders  the example the quickstarts run
docs/            what you are reading, plus runbooks, reference and security notes
scripts/         checks and tools: docs:check, check:terraform, the smoke scripts, test-transport
test/            suites across packages: architecture, contract, model, scenarios, workflow, docs, support
```

## Licence

MIT. Contributions are accepted under the same licence.
