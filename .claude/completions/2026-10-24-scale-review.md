# Scale review (2026-10-24)

Plan: [.claude/.planning/scale-review/CURRENT.md](../.planning/scale-review/CURRENT.md). Nothing is committed or pushed.

## Changed

- **Sender (batch routes):** `packages/maintenance/src/{webhookBatchSend,webhookLoop,webhookSender}.ts`. `mayHaveMore` makes
  the sender claim again at once while a batch route may have more due. 195 to 12,419 events a second. New test in
  `webhook.batch.db.test.ts`; `scripts/sender-load.ts` reproduces the numbers.
- **Completed-job retention:** migration 24 (`qcloud_jobs_completed_idx`, partial on `state = 'completed'`),
  `store/completedRetention.ts`, a first step of the tick's `retention` upkeep, `completedRetentionMs` in settings and
  context, `QCLOUD_COMPLETED_RETENTION_MS` in `maintenance/src/env.ts` and `cli.ts`. Default 7 days, `0` keeps. Tests:
  `completed.retention.test.ts` (5), `schema.migrate.completedRetention.test.ts`, a planned-index row, regenerated
  `schema.snapshot.txt`; `schema.migrate.queuePolicy.test.ts` now expects `LATEST_VERSION`.
- **Crons:** `cron.scale.test.ts` (250 and 1,000 crons due in one minute fire once, tick after tick, with bounded passes).
- **Helm:** HPA, KEDA and PDB for the API, the ingest and the sender; `guard.yaml` refuses a render whose maximums exceed
  `database.maxConnections`; `ci/autoscaling.yaml`; `test/docs/chart.test.ts`; a CI step.
- **AWS control plane:** `autoscaling.tf` (target tracking on CPU for the API and the ingest), `api_max_instances`,
  `ingest.max_instances`, `autoscaling_cpu_target_percent`, `ignore_changes = [desired_count]` on both services, the
  connection budget and subnet room counted at the maximum. `check:terraform` extended (new variations, refusals and a
  mutation check that a wrong cooldown fails).
- **Docs:** `limits.md` (sender and capacity tables, retention measurement), `production.md` (new Volume section,
  retention and autoscaling rows), `webhooks.md`, `operations.md`, `concepts.md`, `reference/configuration.md`,
  `quickstart-kubernetes.md`, `runbooks/deploy-aws.md`, `infra/aws/control-plane/README.md`, a superseded note in
  `spikes/06-phase0-gate.md`.

## Ran, and against what

| Check | Result |
| --- | --- |
| Gate (typecheck, lint, format:check, architecture, `bun test`), Postgres 18 on 127.0.0.1:55442, `QCLOUD_REQUIRE_DB=1`, Pub/Sub emulator and ElasticMQ up | 6,554 pass, 29 skip, 1 fail (below) |
| `bun run test:model` | 31 pass |
| `bun run check:terraform` | 204, 863, 163 and 3,040 checks pass (plans against placeholder credentials) |
| `bun run docs:check` | passes |
| Measurements | one machine, local Postgres 18: crons, 1M waiting jobs, 1M completed jobs, ingest, sender (see `limits.md`) |

**The one failure** is `test/docs/release.test.ts` (package metadata): `LICENSE` carries `Copyright (c) 2024 Egeo Minotti`
and the test expects only the `ChxisB` line. It failed before this work and is yours to decide.

## Not run, or owed

- Nothing ran on a real cloud (D9): no `terraform apply`, no `gcloud` or `aws` write, no real Pub/Sub or SQS.
- PgBouncer and TLS suites were not run (no Docker, by instruction).
- The Helm KEDA ScaledObject renders and is tested, but KEDA was not installed.
- Sender load excludes the socket pool, DNS and `PER_DESTINATION`; a hot route with several loop senders can idle up to
  500 ms after a claim collision (documented).
- `qcloud_requests` is a plain table with per-row delete retention, not partitioned; autovacuum tuning is unmeasured.
- Migration 24 locks writes to `qcloud_jobs` while the index builds (1.1 s at 1M rows); not tried at 100M+.
- The heartbeat cost of large worker batches, and bell-per-job on real SQS, are unmeasured.
- Per-queue completed-job windows are not implemented (`shortcut:` in `completedRetention.ts`).
- AWS `webhook_sender` is still a fixed count. The panel is not autoscaled (it holds no connection).
- No independent security review; no accessibility check of the new panel cards.
