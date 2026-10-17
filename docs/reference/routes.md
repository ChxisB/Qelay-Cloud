# Control API routes

> Generated from [openapi.yaml](../openapi.yaml) by `bun run docs:check --write`. Do not edit it by hand: change the source.

105 operations. The schemas, parameters and every response are in [openapi.yaml](../openapi.yaml); a test
fails when a served route is missing from it or the other way round. `GET /health` takes no token; every other route
takes a bearer token, and a route that changes something needs the `operator` role.

## health

| Method | Path | What it does |
| --- | --- | --- |
| GET | `/health` | Liveness |
| GET | `/health/ready` | Readiness |
| GET | `/ready` | Readiness (alias) |
| GET | `/ping` | The panel's server page ping |
| GET | `/storage` | The panel's storage status |

## capabilities

| Method | Path | What it does |
| --- | --- | --- |
| GET | `/capabilities` | What this deployment runs and what the panel should show |

## dashboard

| Method | Path | What it does |
| --- | --- | --- |
| GET | `/dashboard` | Overview for the panel's home page |
| GET | `/stats` | Counts and rates |
| GET | `/dashboard/queues` | Queues as the dashboard lists them |
| GET | `/dashboard/queues/{queue}` | One queue as the queue page reads it |

## queues

| Method | Path | What it does |
| --- | --- | --- |
| GET | `/queues/summary` | Every queue with its counts |
| GET | `/queues/{queue}/counts` | Jobs of a queue by state |
| GET | `/queues/{queue}/paused` | Whether a queue is paused |
| POST | `/queues/{queue}/pause` | Pause a queue |
| POST | `/queues/{queue}/resume` | Resume a queue |
| POST | `/queues/{queue}/drain` | Delete the jobs that have not run |
| POST | `/queues/{queue}/clean` | Delete finished jobs older than a grace period |
| POST | `/queues/{queue}/obliterate` | Delete a queue and all its jobs |
| POST | `/queues/{queue}/promote-jobs` | Make delayed jobs due now |
| PUT | `/queues/{queue}/rate-limit` | Limit how many jobs start per window |
| DELETE | `/queues/{queue}/rate-limit` | Lift the rate limit |
| PUT | `/queues/{queue}/concurrency` | Limit active jobs of a queue |
| DELETE | `/queues/{queue}/concurrency` | Lift the concurrency limit |
| GET | `/queues/{queue}/stall-config` | Stall settings of a queue |
| PUT | `/queues/{queue}/stall-config` | Set how often a job may stall before it fails |

## jobs

| Method | Path | What it does |
| --- | --- | --- |
| GET | `/queues/{queue}/jobs/list` | Jobs of a queue, one page |
| POST | `/queues/{queue}/jobs` | Add one job |
| POST | `/queues/{queue}/jobs/bulk` | Add up to 10,000 jobs |
| GET | `/jobs/{id}` | One job in full |
| DELETE | `/jobs/{id}` | Remove a job |
| GET | `/jobs/custom/{customId}` | One job by its custom id |
| GET | `/jobs/{id}/result` | The return value of a job |
| GET | `/jobs/{id}/logs` | Log lines of a job |
| POST | `/jobs/{id}/logs` | Add a log line |
| DELETE | `/jobs/{id}/logs` | Delete the log lines of a job |
| GET | `/jobs/{id}/children` | Children of a flow job |
| PUT | `/jobs/{id}/data` | Replace the data of a job |
| PUT | `/jobs/{id}/priority` | Change the priority of a waiting job |
| PUT | `/jobs/{id}/delay` | Change when a delayed job is due |
| POST | `/jobs/{id}/promote` | Make a delayed job due now |
| POST | `/jobs/{id}/progress` | Report the progress of an active job |

## dlq

| Method | Path | What it does |
| --- | --- | --- |
| GET | `/queues/{queue}/dlq` | The failed jobs of a queue, with how each one failed |
| GET | `/queues/{queue}/dlq/stats` | Counts of the dead-letter queue |
| POST | `/queues/{queue}/dlq/purge` | Delete every entry of the dead-letter queue |
| GET | `/queues/{queue}/dlq-config` | Retention and auto-retry settings of the dead-letter queue |
| PUT | `/queues/{queue}/dlq-config` | Save the dead-letter queue's settings |

## flows

| Method | Path | What it does |
| --- | --- | --- |
| GET | `/flows` | The flows of the namespace, newest first |
| GET | `/flows/{id}` | One flow as a list of jobs |
| POST | `/flows/{id}/actions` | Retry the failed children of a flow, promote a stuck parent, or remove the flow |

## workflows

| Method | Path | What it does |
| --- | --- | --- |
| GET | `/workflows` | The workflows of the namespace, and one page of their runs |
| GET | `/workflows/executions/{id}` | One workflow run |
| GET | `/workflows/executions/{id}/steps` | The steps of a run, a page at a time |
| POST | `/workflows/executions/{id}/actions` | Signal, cancel, recover or unblock the rollback of a run |

## cron

| Method | Path | What it does |
| --- | --- | --- |
| GET | `/crons` | Every cron |
| POST | `/crons` | Create or replace a cron |
| GET | `/crons/{name}` | One cron |
| PUT | `/crons/{name}` | Create or replace the cron of this name |
| DELETE | `/crons/{name}` | Delete a cron |

## webhooks

| Method | Path | What it does |
| --- | --- | --- |
| GET | `/webhooks` | The registered webhooks |
| POST | `/webhooks` | Register a webhook |
| GET | `/webhooks/{id}` | One webhook |
| DELETE | `/webhooks/{id}` | Delete a webhook |
| PUT | `/webhooks/{id}/enabled` | Enable or disable a webhook |
| POST | `/webhooks/{id}/test` | Queue a test event |
| GET | `/webhooks/{id}/deliveries` | The delivery history of a webhook |
| POST | `/webhooks/{id}/deliveries/{deliveryId}/retry` | Retry a failed delivery |

## workers

| Method | Path | What it does |
| --- | --- | --- |
| GET | `/workers` | The worker registry |
| DELETE | `/workers/{id}` | Remove a worker from the registry |

## events

| Method | Path | What it does |
| --- | --- | --- |
| GET | `/events` | Live job events of every queue (server-sent events) |
| GET | `/events/queues/{queue}` | Live job events of one queue (server-sent events) |

## metrics

| Method | Path | What it does |
| --- | --- | --- |
| GET | `/metrics` | The four counters of the namespace |
| GET | `/metrics/queues/{queue}` | Jobs completed and failed over time |

## audit

| Method | Path | What it does |
| --- | --- | --- |
| GET | `/audit` | The operator audit log |

## transport

| Method | Path | What it does |
| --- | --- | --- |
| GET | `/transport` | The doorbell path, queue by queue |
| GET | `/transport/dead-letters` | A sample of the poison doorbells of one queue |

## deployment

| Method | Path | What it does |
| --- | --- | --- |
| GET | `/deployment` | What is deployed, and whether it is keeping up |

## unsupported

Qelay features with no meaning on a managed queue. Always 501 `not_supported`.

| Method | Path | What it does |
| --- | --- | --- |
| POST | `/jobs/{id}/fail` | Not supported: fail |
| POST | `/jobs/{id}/discard` | Not supported: discard |
| POST | `/jobs/{id}/move-to-wait` | Not supported: move-to-wait |
| POST | `/jobs/{id}/move-to-delayed` | Not supported: move-to-delayed |
| POST | `/queues/{queue}/dlq/retry` | Not supported: retry every DLQ entry |
| POST | `/queues/{queue}/dlq/{jobId}/retry` | Not supported: retry one DLQ entry |
| POST | `/gc` | Not supported: run the garbage collector |
| GET | `/heapstats` | Not supported: heap statistics |
| GET | `/prometheus` | Not supported: Prometheus scrape of a Qelay server |
| GET | `/server/{path}` | Not supported: GET server |
| POST | `/server/{path}` | Not supported: POST server |
| PUT | `/server/{path}` | Not supported: PUT server |
| DELETE | `/server/{path}` | Not supported: DELETE server |
| GET | `/database/{path}` | Not supported: GET database |
| POST | `/database/{path}` | Not supported: POST database |
| PUT | `/database/{path}` | Not supported: PUT database |
| DELETE | `/database/{path}` | Not supported: DELETE database |
| GET | `/backup/{path}` | Not supported: GET backup |
| POST | `/backup/{path}` | Not supported: POST backup |
| PUT | `/backup/{path}` | Not supported: PUT backup |
| DELETE | `/backup/{path}` | Not supported: DELETE backup |
| GET | `/fleet/{path}` | Not supported: GET fleet |
| POST | `/fleet/{path}` | Not supported: POST fleet |
| PUT | `/fleet/{path}` | Not supported: PUT fleet |
| DELETE | `/fleet/{path}` | Not supported: DELETE fleet |
| GET | `/queue-operations/{path}` | Not supported: GET queue-operations |
| POST | `/queue-operations/{path}` | Not supported: POST queue-operations |
| PUT | `/queue-operations/{path}` | Not supported: PUT queue-operations |
| DELETE | `/queue-operations/{path}` | Not supported: DELETE queue-operations |
