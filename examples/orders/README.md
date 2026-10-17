# Example: orders

A small shop backend on Qelay-Cloud: the five things every queue user does, each as one small file.

| Job | Shows | Where |
| --- | --- | --- |
| `order-placed` | an ordinary job, added in bulk | [producer.ts](src/producer.ts) |
| `payment-reminder` | a delayed job (an hour out by default) | [producer.ts](src/producer.ts) |
| `daily-report` | a cron job, created by the tick, never by the producer | [schedule.ts](src/schedule.ts) |
| `charge-card` | a job that always fails: three tries, 500 ms apart, then the dead-letter queue | [jobs.ts](src/jobs.ts) |
| the worker | claims on a bell, runs the processor, optionally runs the tick | [worker.ts](src/worker.ts) |

[runtime.ts](src/runtime.ts) builds what every process needs (database, store, doorbell). Settings come from the same
variables the tick service reads: `QCLOUD_DATABASE_URL`, `QCLOUD_NAMESPACE`, `QCLOUD_TRANSPORT` (`postgres` is the
default here, `gcp-pubsub` and `aws-sqs` the others), `QCLOUD_GCP_PROJECT`, `QCLOUD_AWS_REGION`. They are listed in [docs/limits.md](../../docs/limits.md).

## Run it locally (Postgres is the doorbell)

```bash
docker compose -f examples/orders/docker-compose.yml up -d --wait   # Postgres 16 on 127.0.0.1:55452
bun run examples/orders/src/migrate.ts                              # create the qcloud_* tables
bun run examples/orders/src/worker.ts                               # terminal 1: worker plus the in-process tick
bun run examples/orders/src/producer.ts 5                           # terminal 2: 5 orders, a reminder, a failing charge
docker compose -f examples/orders/docker-compose.yml down -v
```

The worker prints each job as it completes or fails. The charge fails three times and is then in the dead-letter
queue: `queue.getDlq()` lists it with the reason `max_attempts_exceeded`. Nothing in this example registers the cron
entry in the long-running form; `bun run examples/orders/src/demo.ts` does, with a 500 ms period, so it ends in seconds.

`demo.ts` is the whole example in one process and checks what it did (exit code 1 if anything differs). The same code
runs as a test in [orders.test.ts](orders.test.ts), part of `bun test` when a Postgres is reachable.

## Run it on GCP

The infrastructure is [infra/gcp](../../infra/gcp): Cloud SQL, Pub/Sub, Cloud Run for the workers and the tick, Cloud
Scheduler as the tick's clock. To run this example on it:

1. Apply `infra/gcp/example` with `queues = { orders = {} }` and the namespace `orders`. Applying creates paid, shared
   resources: it needs your explicit decision, and nothing in this repository has ever done it ([Needs D9](../../infra/gcp/README.md#needs-d9-what-has-never-run)).
2. Build an image that runs `bun run examples/orders/src/worker.ts` and give it to `worker_services` as `worker_image`
   with `QCLOUD_TRANSPORT=gcp-pubsub`. The repository builds the Control API and the panel images
   ([packages/control-api/Dockerfile](../../packages/control-api/Dockerfile), [packages/panel/Dockerfile](../../packages/panel/Dockerfile)),
   not a worker image: your worker is your code, so this step is yours. On `gcp-pubsub` the worker does not run a tick:
   the tick service does, once a minute.
3. Run `migrate.ts` once against the database through its private address (from a Cloud Run job or a bastion in the
   VPC), then `producer.ts` the same way.

What changes with the hosting mode is **when** things happen, not whether: with the tick only on Cloud Scheduler, the
reminder runs at its due time within a minute after it, the cron entry fires at its minute boundary, and a retry's
500 ms backoff becomes up to a minute. [docs/limits.md](../../docs/limits.md) has the table.
