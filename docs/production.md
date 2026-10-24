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
- **The sender sends one batch per route per claim.** On the scheduler alone that is one batch a minute per route, so 100 events a minute
  at the default (**derived** from [limits.md section 12](limits.md#12-webhooks-task-52)). A route that gathers a night's events needs a
  tick that runs often, or `qcloud-tick send` as its own process, to catch up quickly after the fire.
- The sender sends at most 50 attempts a minute for the whole service on the scheduler alone, and 60 a minute per webhook; a batch
  counts as one attempt (**derived**). Past that, raise `QCLOUD_WEBHOOK_BATCH` and `QCLOUD_WEBHOOK_RATE_PER_MINUTE`.

## Retention

| What | Setting | Start with |
| --- | --- | --- |
| Failed jobs (the dead-letter queue) | `PUT /queues/{queue}/dlq-config`: `maxAge` and `maxEntries` | Set both, so the table cannot grow without bound; lowering them deletes the oldest at once (**chosen**) |
| Finished deliveries | `QCLOUD_WEBHOOK_KEEP_MS` | `172800000`, two days (the default) |
| Event journal and completions | `QCLOUD_TICK_MAX_ITEMS` | `200` per pass (the default); a 100,000-job burst leaves the journal above its cap for a while and it comes down over later beats (**measured**) |

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
