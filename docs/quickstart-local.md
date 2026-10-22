# Quickstart: run it on your machine

You will run a worker, the Control API and the panel against a local Postgres, add jobs, and watch one of them fail
into the dead-letter queue. It takes about ten minutes and costs nothing: no cloud account, no Docker needed beyond
Postgres itself.

Locally the doorbell is Postgres too (`QCLOUD_TRANSPORT=postgres`): the workers poll the database every 250 ms instead
of waiting for Pub/Sub or SQS. That is for development and tests, and it is the one thing that differs from a cloud
deployment. The next steps are [GCP](quickstart-gcp.md) and [AWS](quickstart-aws.md); the ideas are in
[concepts](concepts.md).

## What you need

- [Bun](https://bun.sh) 1.4.2 (the version in `.bun-version`). Qelay-Cloud uses `Bun.SQL`, so it does not run on Node.
- A Postgres 18 or later you can create a database in. The compose file below starts one on port 55452.

The repository is the package for now: nothing is published yet, so you work from a checkout.

> Not run: `docs:check` runs the rest of this page inside an installed checkout, against a throwaway database of the
> Postgres the test suite uses, and sets `QCLOUD_DATABASE_URL` itself.

```bash notrun
bun install --frozen-lockfile
docker compose -f examples/orders/docker-compose.yml up -d --wait
export QCLOUD_DATABASE_URL=postgres://qcloud:qcloud@127.0.0.1:55452/orders
```

## 1. Create the tables

Every process reads the same settings from the environment. `QCLOUD_NAMESPACE` separates deployments on one database
(the example's queue is `orders`, in the namespace `orders`).

```bash test
export QCLOUD_NAMESPACE=orders
export QCLOUD_TRANSPORT=postgres
bun run examples/orders/src/migrate.ts
```

The output says `schema migrated from empty to <n>`. Running it again says `schema already at version <n>`. Migrations
only move forward and are safe with old workers connected: see [operations](operations.md#upgrading).

## 2. Start a worker

The worker claims jobs when a bell rings and runs them. In this example it also runs the maintenance tick in its own
process every 5 seconds, because there is no Cloud Scheduler on your machine. The tick is what rings delayed and retried
jobs when they are due ([concepts](concepts.md#the-maintenance-tick)).

```bash test
export LOGS=$(mktemp -d)
bun run examples/orders/src/worker.ts > "$LOGS/worker.log" 2>&1 &
```

In your own terminal, drop the redirect and leave it running in a second window to watch the jobs go by.

## 3. Start the Control API

The Control API is what the panel and your scripts talk to. For local use it accepts one static development token. It
refuses to start with that token when `NODE_ENV=production`, and with it when listening beyond loopback, so it cannot
reach a deployed environment by accident ([configuration](reference/configuration.md)).

```bash test
export QCLOUD_API_DEV_TOKEN=local-development-token-0123456789
export QCLOUD_API_CORS_ORIGINS=http://127.0.0.1:8081
bun run packages/control-api/src/bin.ts serve > "$LOGS/api.log" 2>&1 &
for _ in $(seq 1 100); do
  curl -fsS http://127.0.0.1:8080/health > /dev/null 2>&1 && break
  sleep 0.2
done
curl -fsS http://127.0.0.1:8080/health
```

`/health` needs no token and answers `{"ok":true,"status":"healthy",...}`. Every other route wants
`Authorization: Bearer <token>`.

## 4. Add jobs

[`examples/orders`](../examples/orders/README.md) is the whole application in five small files. The producer adds five
orders in one call, a reminder that is due in an hour, and a charge that always fails:

```bash test
bun run examples/orders/src/producer.ts 5
```

The `charge-card` job has three tries, 500 ms apart ([`jobs.ts`](../examples/orders/src/jobs.ts)). Its processor throws
every time, so after the third try the job moves to the dead-letter queue with the reason `max_attempts_exceeded`.

```bash test
AUTH="Authorization: Bearer $QCLOUD_API_DEV_TOKEN"
for _ in $(seq 1 90); do
  dlq=$(curl -fsS -H "$AUTH" http://127.0.0.1:8080/queues/orders/dlq)
  [[ "$dlq" == *'"reason":"max_attempts_exceeded"'* ]] && break
  sleep 1
done
[[ "$dlq" == *'"reason":"max_attempts_exceeded"'* ]]
curl -fsS -H "$AUTH" http://127.0.0.1:8080/queues/orders/counts
```

The counts show `"completed":5`, `"failed":1` and `"delayed":1`: the orders ran, the charge is in the dead-letter
queue, and the reminder waits for its hour. `GET /queues/summary` gives the same for every queue, and
`GET /queues/orders/jobs/list` lists the jobs ([all routes](reference/routes.md)). The worker's log has the story:

```bash test
completed=$(grep -c '^completed order-placed' "$LOGS/worker.log")
tries=$(grep -c '^failed charge-card' "$LOGS/worker.log")
echo "orders completed: $completed, charge attempts: $tries"
[ "$completed" = 5 ]
[ "$tries" = 3 ]
```

It prints `orders completed: 5, charge attempts: 3`.

## 5. Open the panel

The panel is a static single-page app served by a small Bun server. Build it once, then serve it in token mode, which
asks you for the same bearer token instead of signing you in with an identity provider.

```bash test
bun run --cwd packages/panel build > "$LOGS/panel-build.log" 2>&1
export QCLOUD_PANEL_PORT=8081
export QCLOUD_PANEL_AUTH_MODE=token
export QCLOUD_PANEL_API_BASE_URL=http://127.0.0.1:8080
bun run packages/panel/serve/main.ts > "$LOGS/panel.log" 2>&1 &
for _ in $(seq 1 100); do
  curl -fsS http://127.0.0.1:8081/config.json > /dev/null 2>&1 && break
  sleep 0.2
done
curl -fsS http://127.0.0.1:8081/config.json
```

Open <http://127.0.0.1:8081>. The panel shows an "Authentication required" box: paste
`local-development-token-0123456789` and continue. You should see the `orders` queue with five completed jobs, one in the
dead-letter queue and one delayed; click the queue to list them, and open the failed `charge-card` job for its three
attempts. The dead-letter page can purge entries but not retry them: retrying a dead letter is
[not supported in v1.0.0](unsupported.md).

## 6. Use it from your own code

Your application builds a store and a transport once and hands them to a `Queue` and a `Worker`. The example's
[`runtime.ts`](../examples/orders/src/runtime.ts) does that for the three transports; the rest is the BullMQ-style API:

```ts
import { Queue, Worker } from 'qelay-cloud';
import { openRuntime, ordersEnv } from './runtime';

const runtime = openRuntime(ordersEnv());
const queue = new Queue('orders', { store: runtime.store, transport: runtime.transport });
await queue.add('order-placed', { orderId: 1 }, { delay: 5_000, attempts: 3, backoff: 500 });

const worker = new Worker(
  'orders',
  async (job) => `charged ${job.data.orderId}`,
  { store: runtime.store, transport: runtime.transport, concurrency: 5 }
);
worker.on('completed', (job) => console.log('done', job.id));
```

Coming from Qelay? [Moving from Qelay](migration.md) lists what to change. The exact names are in
[`reference/sdk-exports.md`](reference/sdk-exports.md).

## Clean up

Press Ctrl-C in each terminal (the API and the worker drain before they exit), then remove the database:

> Not run: it deletes the Postgres this page started, and the checker never started one.

```bash notrun
docker compose -f examples/orders/docker-compose.yml down -v
```

## Where to go next

- [Quickstart: GCP](quickstart-gcp.md) or [AWS](quickstart-aws.md): the same example on Pub/Sub or SQS.
- [Concepts](concepts.md): why Postgres holds the state and the cloud queue only rings a bell.
- [Operations](operations.md): connection budgets, the tick, upgrades.
