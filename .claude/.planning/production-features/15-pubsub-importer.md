# 15 — Pub/Sub importer and cutover runbook

**Status:** done · **Depends on:** 12 · **Touches:** packages/transport-gcp, docs/runbooks
**Design:** none (reuses existing pages and parts)

## Goal
A tool that pulls a Pub/Sub subscription and adds each message as a job, and a runbook for the cutover.

## Steps
1. Read transport-gcp receiver and the package bin pattern first (the architecture check keeps broker code out of core, sdk and the store, so this lives in transport-gcp).
2. `qcloud-import-pubsub --subscription S --queue Q [--dry-run] [--max N]`: pull in pages, `addBulk` with jobId = Pub/Sub messageId (re-pulls dedupe), ack after the commit, stop when the subscription is empty. Message attributes become job data fields; the body is JSON or text.
3. Runbook: drain, or run side by side with a producer switch; what the importer does not move (ordering keys, per-message delay).
4. Emulator test only; the tool refuses a non-emulator project unless QCLOUD_REAL_CLOUD=1 (D9).

## Acceptance
- On the emulator, 250 messages become 250 jobs; a second run adds none; every message is acked once.
- A crash between add and ack re-delivers a message and adds no duplicate.
- Without QCLOUD_REAL_CLOUD=1 and with a real project name the tool refuses.
- The runbook is in docs/runbooks and listed in the index.

## Verify
```bash
QCLOUD_REQUIRE_DB=1 QCLOUD_REQUIRE_PUBSUB=1 bun test packages/transport-gcp --grep import
```

## Result
Done. `qcloud-import-pubsub` (a bin of `packages/transport-gcp`) moves a subscription into a queue.

- `src/importer.ts`: `importSubscription(source, sink, options)` pulls a page, stores it in one `addBulk` transaction with `jobId` = Pub/Sub messageId, then acks. A page that fails to store is handed back at once (ack deadline 0); a crash between the add and the ack delivers it again when the deadline ends and the job ids dedupe it. The body is JSON when it parses and text otherwise, the attributes are fields beside `body`. `--dry-run` stores and acks nothing and gives every message back. `importSource` is the real source over the library's v1 `SubscriberClient`.
- `src/importCli.ts` and `src/importBin.ts`: flags `--subscription`, `--queue`, `--job-name` (default `message`), `--dry-run`, `--max`, `--wait` (pull timeout, 1 to 60 s, default 5), `--project`, `--emulator-host`. Exit 0 prints one JSON line (`subscription`, `queue`, `dryRun`, `pulled`, `created`, `acked`), 1 is a failure, 2 is usage or configuration. SIGINT and SIGTERM stop after the page in hand.
- The tool refuses to run unless an emulator host is given (`--emulator-host` or `QCLOUD_PUBSUB_EMULATOR_HOST`) or `QCLOUD_REAL_CLOUD=1` (D9). With the real cloud allowed it refuses a leaked `PUBSUB_EMULATOR_HOST`, which would hide the pull in an emulator.
- `packages/transport-gcp` now depends on `qelay-cloud` (`workspace:*`, tsconfig reference to `../sdk`), so the importer adds jobs through the SDK `Queue`. The architecture check still passes: only core, sdk, store-postgres, maintenance, control-api and ingest are barred from broker code. `bun.lock` gained the bin and the workspace line.
- Runbook `docs/runbooks/import-from-pubsub.md`, listed in `docs/runbooks/README.md`; two variables added to `docs/reference/configuration.md`; `docs/reference/sdk-exports.md` regenerated.
- Deviations: `--wait` and a default of 2 empty pulls in a row (`emptyPulls`) were added because a pull on an empty subscription blocks for its whole timeout on the emulator and an empty answer can come while messages remain. One known limit is a `shortcut:` comment: a message delivered again after its job already finished adds a new job (a finished job's id is taken over), so it runs twice; pause the queue while importing when that is not safe.

Ran, against local Postgres 18 (127.0.0.1:55442) and the Pub/Sub emulator (127.0.0.1:58085): `QCLOUD_REQUIRE_DB=1 QCLOUD_REQUIRE_PUBSUB=1 bun test packages/transport-gcp --grep import` 9 pass; the whole `packages/transport-gcp` and `test/contract` 226 pass, 36 skip (SQS emulator not running), 0 fail; `bun run typecheck`, `bun run lint` (0 errors), `bun run format:check`, `bun run architecture`, `bun run docs:check` all pass. The 250-message test, the crash test (deadline 10 s, run after 11 s) and the CLI test (dry run, then a real run through the injected store) are in `test/import.test.ts`.

Not run: Google Cloud (never, D9); the CLI through `QCLOUD_DATABASE_URL` (only the injected-store path is tested; the same `Queue` options as the SDK use); ordering keys and per-message delay are not moved and the runbook says so.
