# Qelay-Cloud

A job queue with the API of [Qelay](https://github.com/ChxisB/qelay), run on managed cloud services. **Postgres holds every
job.** A cloud queue (Google Pub/Sub or Amazon SQS) only rings a doorbell to wake workers. You get Qelay's `Queue`,
`Worker`, `FlowProducer` and `QueueEvents`, a control panel, and Terraform for GCP and AWS, with no server of your own to run.

```ts
import { Queue, Worker } from 'qelay-cloud';

// `store` and `transport` come from your setup: Postgres plus the doorbell of your cloud (or Postgres itself).
const queue = new Queue('orders', { store, transport });
await queue.add('order-placed', { orderId: 1 }, { delay: 5_000, attempts: 3, backoff: 500 });

const worker = new Worker('orders', async (job) => `charged ${job.data.orderId}`, { store, transport, concurrency: 5 });
worker.on('completed', (job) => console.log('done', job.id));
```

## Status

This is release **1.0.0, not yet published** (the package is `0.0.0` until the owner releases it).

- **Run on your machine:** everything. The Postgres transport needs no cloud account, and the Pub/Sub and SQS transports
  are tested against their emulators.
- **Never run on a real cloud.** The Terraform is validated and planned without credentials, and nothing has been applied to
  a real GCP project or AWS account. The cloud quickstarts say so, and
  [what has never run](docs/limits.md#8-what-has-not-been-run) is a list, not a footnote.
- **Not the whole of Qelay.** Repeat jobs, job-group admin methods and re-running a completed job are not here. Each one
  fails by name, never silently ([unsupported.md](docs/unsupported.md)). A failed job is put back from the dead-letter queue
  with `retryDlq` or `retryDlqMany`.
- **Open issues and what was never run:** [known-issues.md](docs/known-issues.md). Read it before you rely on a release.

## Where to start

| You want to | Read |
| --- | --- |
| Run it in five minutes, on your machine | [Quickstart: local](docs/quickstart-local.md) |
| Run it on Google Cloud or AWS | [Quickstart: GCP](docs/quickstart-gcp.md), [Quickstart: AWS](docs/quickstart-aws.md) |
| Run it on Kubernetes | [Quickstart: Kubernetes (Helm)](docs/quickstart-kubernetes.md) |
| Understand how it works | [Concepts](docs/concepts.md), then [Architecture](docs/architecture.md) |
| Move an app that uses Qelay | [Moving from Qelay](docs/migration.md), then [compat.md](docs/compat.md) |
| Move off Google Pub/Sub | [Import from Pub/Sub](docs/runbooks/import-from-pubsub.md) (tested on the emulator only) |
| Operate it | [Operations](docs/operations.md), [production settings](docs/production.md), [limits](docs/limits.md), [settings](docs/reference/configuration.md) |
| Change it | [CONTRIBUTING.md](CONTRIBUTING.md) and [DESIGN.md](DESIGN.md) |

## What you get

- **Delivery you can reason about.** A job is a row. It is settled only by the worker that holds its lease, and delivery is
  at least once, so handlers are idempotent.
- **A repair loop.** One idempotent tick recovers dead workers' jobs, runs cron, rings delayed jobs and rings again whatever a
  lost bell left behind. Hosted on the cloud scheduler it is up to a minute late; run in an always-on worker it is seconds
  ([how late, per hosting mode](docs/limits.md#1-delay-precision-by-hosting-mode)).
- **A bounded cost.** The connection budget is a formula, and Terraform refuses a plan that breaks it
  ([operations](docs/operations.md#connection-budget)).
- **Workers that take a batch.** Give a `Worker` `batch: { size, maxWaitMs }` and its handler gets up to `size` jobs at once.
- **Policy per queue.** Each queue has its own retry policy and run window, so a queue that should only run overnight does
  ([production settings](docs/production.md#a-queues-retry-policy)).
- **Inbound sources.** Whatever is posted to a source URL is stored, filtered, de-duplicated, delayed or reshaped by a route,
  then delivered. Routes can send on a schedule or in signed batches ([event gateway](docs/event-gateway.md#sources)).
- **A control panel and API** for queues, jobs, flows, workflows, workers, the dead-letter queue, cron, sources and an event
  gateway (webhooks, and "when this happens, add a job" routes), signed in with your OpenID Connect provider
  ([routes](docs/reference/routes.md)).
- **No surprise about backups.** Qelay takes no backups, so the panel asks you to say who does. Until someone answers, the
  Deployment and Home pages carry a warning ([operations](docs/operations.md)).

## Licence

MIT, as Qelay before it. The upstream notice is in [LICENSE](LICENSE), and [docs/PORTING.md](docs/PORTING.md)
records which code was ported from where.
