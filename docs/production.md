# Production settings

The settings to start a production deployment with, why each one, and where the number comes from. A value marked
**measured** has a run behind it in [limits.md](limits.md); one marked **chosen** is a judgement that nobody has measured.
Change a chosen value when your workload says to. The Deployment page (`GET /deployment`, the panel's Deployment tab) warns
when the setup contradicts something here; the warnings are at the end.

## The tick

| Setting | Start with | Why |
| --- | --- | --- |
| An always-on tick (`qcloud-tick loop`), one instance or two for failover | Run it, and keep the scheduler job | Delays, retry backoff, rate-limit resumption, crons, scheduled sends and run windows all start at the tick. The scheduler alone gives **mean about 30 s, worst about 60 s**; a tick every second gave a worst gap of 1,717-1,743 ms against a bound of 2,250 ms (**measured**, [limits.md section 1](limits.md#1-delay-precision-by-hosting-mode)) |
| `QCLOUD_TICK_INTERVAL_MS` | The real period: `60000` on the scheduler alone, `1000` for `qcloud-tick loop` | The Control API reads the same variable to tell whether a route's delay is finer than the tick can keep ([warnings](#what-the-deployment-page-warns-about)) |
| `QCLOUD_TICK_UPKEEP_EVERY_MS` | `30000` for a loop (its default) | Retention steps run once per this many ms, and the beats between do only recovery, crons, promotion, expiry and rings |
| `QCLOUD_API_TICK_LATE_AFTER_MS`, `QCLOUD_API_TICK_STALE_AFTER_MS` | The defaults, `60000` and `300000`, for a scheduler; lower them with a loop | They decide when the page says late and stale |

## Workers and the database

- **Write-heavy queues: turn on `groupCommit` and `groupComplete`** in the worker. Every commit that writes events passes one
  advisory lock per namespace (0.9 to 1.2 waiters per poll at about 3,000 jobs/s, **measured**); a batch is one pass, so these lower the
  passes per job. They are off by default. The gain on a managed database is not measured
  ([limits.md section 3](limits.md#3-throughput-and-latency-load-check)).
- **Process jobs in batches** with `batch: { size, maxWaitMs }` when the work is cheaper in bulk (one insert for many jobs). A batch
  worker holds `concurrency × size` jobs, and each job beats its own lease, so a size of 1,000 is 1,000 beats per third of the
  lease. Start at a size of 100 (**chosen**).
- **The connection budget.** At the default `max_connections` of 100 a direct fleet tops out at **44 worker processes**; behind a
  transaction pooler the same fleet needs 26 connections whatever its size (**derived** from the budget formula,
  [limits.md section 4](limits.md#4-connections)). Declare the fleet with `QCLOUD_FLEET_WORKERS` (and the variables beside it) so the
  page checks it.
- **Throughput.** One machine drained 100,000 jobs at **1,725-2,090 jobs/s** with a tick every 5 s, and 3,130-3,295 jobs/s with no
  tick (**measured**, a floor for a fleet of separate processes). Size the workers for the backlog you must clear divided by the time you
  have, from those figures.

## A queue's retry policy

A queue can carry the attempts, backoff and time limit for jobs that set none (`PUT /queues/{queue}/policy`, or the Retry policy card on
the queue's page). A job's own option always wins, each setting on its own. Without one, a job that sets nothing gets the SDK's
defaults, which differ from what a Pub/Sub subscription's retry policy did.

- Set **attempts**, an **exponential** backoff with a **longest delay**, and a **time limit** on every queue that took over from a
  Pub/Sub subscription. For example 5 attempts, 5 s growing to 10 minutes, and a limit above your slowest job (**chosen**).
- Jitter is one setting for the whole store, not per queue.
- On Pub/Sub, backoff runs at tick speed: a retry is rung when the tick sees it due ([limits.md section 1](limits.md#1-delay-precision-by-hosting-mode)).

## Run windows

- A window needs **every process on the release that has it** before you set one: an older worker claims at any time.
- It opens at the tick: allow one tick interval (a minute on the scheduler alone). A window is 1 minute to 7 days.
- Jobs pile up while it is closed. Size the workers for the opening, when the whole backlog is claimable at once.
- A window shorter than the tick interval can open and close between two ticks (**derived**): keep a window several tick intervals long.

## Scheduled and batched sends

- A route's **schedule** holds its events until the next fire of its cron, in its zone. A cron that fires less often than every
  31 days is refused. An event still unsent 24 hours after its fire is marked `failed` with `expired` and stays in the history,
  so a fire that finds the sender stopped for a day loses that night's events.
- A **batch** sends the due events as one signed request: up to `maxEvents` (default 100, at most 500) and `maxBytes` (default
  262,144, at most 1,048,576). The receiver must accept a body that large. One event larger than `maxBytes` still goes, alone.
- **A claim takes one batch per route, and the sender claims again at once** while a route may have more due. A backlog of 250
  events at 100 a batch is three requests in one pass, not three passes; one sender process sent 20,000 events as 200 requests at
  12,400 events a second (**measured**, [limits.md section 12](limits.md#12-webhooks-task-52)). A route that gathers a night's events
  catches up after the fire in the seconds the receiver takes to answer, not in minutes.
- The sender makes at most `QCLOUD_WEBHOOK_BATCH` (50) requests a pass and 60 a minute per webhook; a batch counts as one request. A
  route's 60 a minute is the first ceiling a busy route meets, so a batch of 100 is 6,000 events a minute. Past that, raise
  `QCLOUD_WEBHOOK_BATCH` and `QCLOUD_WEBHOOK_RATE_PER_MINUTE`.

## Retention

| What | Setting | Start with |
| --- | --- | --- |
| Failed jobs (the dead-letter queue) | `PUT /queues/{queue}/dlq-config`: `maxAge` and `maxEntries` | Set both, so the table cannot grow without bound; lowering them deletes the oldest at once (**chosen**) |
| Completed jobs | `QCLOUD_COMPLETED_RETENTION_MS` | `604800000`, seven days (the default); `0` keeps them. A queue that completes millions a day holds a week of rows, so size the disk for that, or lower it. `removeOnComplete` on a job removes it at once |
| Finished deliveries | `QCLOUD_WEBHOOK_KEEP_MS` | `172800000`, two days (the default) |
| Event journal and completions | `QCLOUD_TICK_MAX_ITEMS` | `200` per pass (the default); a 100,000-job burst leaves the journal above its cap for a while and it comes down over later beats (**measured**) |
| Gateway requests kept | `QCLOUD_WEBHOOK_KEEP_MS` | Two days, never less than 48 hours; at 5,000 a second that is about 860 million rows, so size the disk |

## Volume: millions of requests, jobs and events

What to set when the numbers are large. A day has 86,400 seconds: 1 million a day is 12 a second, 10 million is 116 a second, 100 million
is 1,160 a second. The figures are from [limits.md](limits.md); each was measured on one machine, so they are floors.

| Load | Do this |
| --- | --- |
| **Events into the gateway** | One ingest instance stores about 5,000 requests a second (**measured**). The shipped limits are lower on purpose (100 a second in all, 10 from one source, per process): raise `QCLOUD_INGEST_RATE_GLOBAL` and `QCLOUD_INGEST_RATE_PER_SOURCE` to the rate you expect plus headroom, and put the per-address limit at the edge. Past 5,000 a second add instances; each takes 2 connections of the budget |
| **Events out of the gateway** | A plain route sends 60 a minute (`QCLOUD_WEBHOOK_RATE_PER_MINUTE`), 8 in flight per sender (`QCLOUD_WEBHOOK_CONCURRENCY`) and 4 to one host (`QCLOUD_WEBHOOK_PER_DESTINATION`). A sender with 32 in flight sends about 1,150 a second against a 20 ms receiver, four of them about 2,700 (**measured**). Run `qcloud-tick send` as its own process, raise the three settings to what the receiver can take, and send in a **batch** (12,400 events a second from one process) or to a **queue** route (a worker fleet then does the work) for the largest volumes |
| **Jobs** | One machine claims and completes 3,000+ jobs a second with no tick and 1,700-2,100 with a 5 s tick. A backlog of 1 million waiting jobs keeps a claim at 0.17 ms and a tick pass under a second (**measured**). Add workers (behind a pooler once the budget says so) and use batches. Completed jobs are deleted after 7 days by default (`QCLOUD_COMPLETED_RETENTION_MS`), about 13,000 a second at the default pass size (**measured**); set `removeOnComplete` on high-volume queues to drop them at once |
| **Crons** | 250 and 1,000 crons due in the same minute each fire exactly once, in under 0.4 s, tick after tick (**measured**, `cron.scale.test.ts`). `QCLOUD_TICK_MAX_ITEMS` (200) is how many a pass fires; the tick repeats a full pass at once |
| **Storage** | Gateway requests and deliveries are kept two days: `events a day × (body size + about 1 KB of headers and row) × 2`, and each delivery adds a row. Raise `autovacuum` on `qcloud_requests` and `qcloud_jobs` (not measured on a real instance) |
| **Autoscaling** | Workers follow the queue's backlog (Cloud Run and KEDA on Pub/Sub, ECS step scaling on SQS, the chart's `autoscaling` block on Kubernetes); the API and ingest follow CPU or requests on Cloud Run and on Kubernetes with `api.autoscaling.enabled`, `ingest.autoscaling.enabled` and `webhooks.sender.autoscaling.enabled`; on AWS the API and the ingest follow average CPU (`autoscaling_cpu_target_percent`, 60) between `api_instances` and `api_max_instances`, and `ingest.instances` and `ingest.max_instances`, which default to the minimum so nothing moves until you raise them; the panel stays at `panel_instances`. Every maximum must fit the connection budget: the chart's guard and the Terraform precondition refuse a plan or render that does not (planned and checked, never applied) |

## What the Deployment page warns about

| Code | Meaning | Fix |
| --- | --- | --- |
| `schedule_without_sender` | Routes hold events for a schedule and the tick that sends them is not running | [Tick stopped](runbooks/tick-stopped.md) |
| `window_without_tick` | A queue is outside its run window and the tick that rings it when it opens is not running | [Tick stopped](runbooks/tick-stopped.md) |
| `delay_finer_than_tick` | A route delays events by less than the tick period you declared, so they go up to one period late | Run a tick every second, or set a longer delay |

The warnings follow from what the page can read. Sending turned off in the tick's own settings (`QCLOUD_WEBHOOK_BATCH=0`) is not
visible to the Control API; a tick that is not running is. `delay_finer_than_tick` needs `QCLOUD_TICK_INTERVAL_MS` set in the
Control API's environment too, and says nothing without it. The window warning counts the queues the page scanned that have jobs
waiting.
