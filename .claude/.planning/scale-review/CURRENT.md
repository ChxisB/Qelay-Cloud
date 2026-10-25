# Scale review: GCP and AWS parity, autoscaling, volume, 200+ crons

**Request (2026-10-24):** review the project end to end. It must work on both GCP and AWS, autoscale easily, and take
millions of requests, jobs and event-gateway events, with 200+ crons running without trouble. Make the improvements.

## Scope

- **In:** measure the hot paths at volume, fix what was wrong, add the missing autoscaling and retention, say what was
  not measured.
- **Out:** real-cloud runs (D9), partitioning `qcloud_requests`, per-queue completed-job windows, any push or version bump.

## Touches

Packages `maintenance`, `store-postgres`; migration 24; `charts/qelay`; `infra/aws/control-plane`; `scripts/`; docs. No
`StateStore` or `DeliveryTransport` interface change, no new public route, no new dependency.

## Human gates (answered 2026-10-24)

| Gate | Answer |
| --- | --- |
| New migration 24 (index for completed-job retention) and its default | 7 days default; `QCLOUD_COMPLETED_RETENTION_MS=0` keeps jobs |
| Anything under `infra/` (AWS API and ingest autoscaling) | Yes, plan and tests only, never `terraform apply` |

## Status

| # | Mini-task | Status |
|---|-----------|--------|
| 1 | 200 and 1,000 crons due in one minute: measure, add `cron.scale.test.ts` | done |
| 2 | Claim, ring and promotion queries at 1M job rows: measure | done |
| 3 | Gateway ingest throughput: measure, document the limits | done |
| 4 | Sender: a batch route drained at one batch per idle wait (195 events/s). Fix `mayHaveMore`, add a back-to-back test, `scripts/sender-load.ts` | done |
| 5 | Helm: HPA, KEDA and PDB for API, ingest and sender; `database.maxConnections` render guard; `ci/autoscaling.yaml`; chart test; CI job | done |
| 6 | Completed jobs were never deleted by default: migration 24, tick step, `QCLOUD_COMPLETED_RETENTION_MS`, tests, planned-index row, snapshot | done |
| 7 | AWS API and ingest ran a fixed count: Application Auto Scaling on CPU, budget counted at the maximum, `check:terraform` extended | done |
| 8 | Docs: volume section, measured tables, retention rows, autoscaling rows | done |
| 9 | Full gate with Postgres up | see the completion note |

## Findings and results

1. **Crons.** 250 and 1,000 crons due in the same minute each fire exactly once, tick after tick, in under 0.4 s. The
   passes are bounded by `maxItems`; the loop repeats within the beat. No change needed beyond the test.
2. **Jobs.** At 1M waiting job rows a claim is 0.17 ms and a tick pass 0.56 to 0.8 s. At 1M completed rows the new
   retention step deletes about 13,000 jobs a second at the default cap and 85,000 at 5,000 (one machine).
3. **Gateway in.** One ingest instance on 2 connections stored about 5,200 posts a second. The shipped rate limits are
   the throttle, not the code. Request retention deletes about 133,000 rows a second.
4. **Gateway out.** A batch route sent 195 events a second because the sender slept 500 ms after every batch; now it
   claims again at once while a batch may have more due: 12,419 a second. Plain routes: about 1,150 a second per sender
   with 32 in flight against a 20 ms receiver.
5. **Autoscaling.** GCP Cloud Run and the Helm chart (now with HPA/KEDA/PDB) already or now scale. AWS workers had step
   scaling; AWS API and ingest were fixed and now track CPU between a minimum and a maximum that default to the same number.
   The connection budget is checked at the maximum everywhere.
6. **Retention.** Completed jobs stayed for ever unless `removeOnComplete` was set; docs said the tick removed them.
   Now it does, after 7 days, oldest first, skipping a job a live flow needs.
7. **Parity.** Pub/Sub and SQS pass the same contract and scenario suites. Both ran on emulators only.

## Not done, on purpose

- `qcloud_requests` stays a plain table with per-row delete retention (partitioning is another migration and gate).
- A hot route with several loop senders can idle up to 500 ms after a claim collision (documented, not changed).
- `webhook_sender` on AWS is still a fixed count.
- Per-queue completed-job windows (`shortcut:` in `completedRetention.ts`).
