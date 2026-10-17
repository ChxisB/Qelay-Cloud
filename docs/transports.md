# Transports

What each broker does behind the one `DeliveryTransport` interface, and where they differ. A difference is a
capability flag below or a row in the matrix; nothing above `packages/transports` branches on a broker, and
`bun run architecture` enforces it. The same contract suite (`test/contract`) and the same end-to-end scenarios
(`test/scenarios`) run against every transport, so a behaviour listed as common is tested on each.

**How to read the evidence.** `declared`: read from the code by the generator. `emulator`: a test against the
Pub/Sub emulator or ElasticMQ, which is **emulator only** evidence (section 4 lists where they differ). `tested`: a
test against real Postgres or in the process. `design`: reasoned, not run. `not run` or `real: not run`: the real
service was never touched; decision D9 keeps real clouds behind `QCLOUD_REAL_CLOUD=1` and the owner's go-ahead.

This file is generated: `bun run docs:transports` rewrites the marked blocks and the hand-written rows live in
`scripts/transportsDocMatrix.ts`. `test/contract/matrix.test.ts` fails when the file and the code disagree.

## 1. What each transport declares

<!-- BEGIN generated:capabilities -->
| Capability | Pub/Sub (`gcp-pubsub`) | SQS (`aws-sqs`) | Postgres (`postgres`) | Memory (tests only) |
| --- | --- | --- | --- | --- |
| `maxDeliverDelayMs`: how far ahead a bell can be rung | 0 (no delivery delay) | 900,000 ms (900 s) | unbounded | unbounded |
| `maxRingBatch`: bells per `ring` call | 1000 | 10 | 1000 | 1000 |
| `attemptCount`: delivery attempt number | `approximate` | `approximate` | `none` | `none` |
| `retryGranularityMs`: finest retry delay (Postgres: its poll interval, default shown) | 1,000 ms (1 s) | 1,000 ms (1 s) | 1,000 ms (1 s) | 1 ms |
<!-- END generated:capabilities -->

Queue statistics freshness, from the `source` and `maxStalenessMs` each `stats` call reports:

<!-- BEGIN generated:stats -->
| Transport | `source` | `maxStalenessMs` |
| --- | --- | --- |
| Pub/Sub | `cloud-monitoring` or `unavailable` | 300,000 (5 min) plus the cache period |
| SQS | `sqs-queue-attributes`, with `+cloudwatch` when age is read | 60,000 (1 min) for counts; 300,000 (5 min) plus the cache period with age |
| Postgres | `postgres-counts` | 0 |
| Memory | `memory` | 0 |
<!-- END generated:stats -->

## 2. Compatibility matrix

<!-- BEGIN generated:matrix -->
| | Pub/Sub (`gcp-pubsub`) | SQS (`aws-sqs`) | Postgres (`postgres`) | Memory (tests only) |
| --- | --- | --- | --- | --- |
| Delay mechanism | None per message. A delayed job is rung by the tick when it is due: tick speed (emulator, design) | `DelaySeconds` on the bell, rounded **up** to a whole second, inside the 900 s window. The tick rings the rest (emulator) | None: the poll loop claims a job once it is due (tested) | The queue holds the bell until due, on the process clock (tested) |
| A delay past the window | Every positive delay is past a window of 0: `delay-too-long`, never clamped (emulator) | `delay-too-long`, never clamped; the store leaves the bell to the tick (emulator) | No window: nothing is too long (declared) | No window: nothing is too long (declared) |
| Ordering | None promised; bells are fungible and the store orders the claim (design) | Standard queue: best effort, none promised (design) | None promised; the poll finds the next claimable job (tested) | None promised; the in-process queue hands bells out as they are due (design) |
| Delivery guarantee | At least once: a bell can arrive twice and the claim is exclusive (emulator; duplicate-bell scenario) | At least once: a standard queue can duplicate; ElasticMQ never does (emulator, design) | A notification and a poll: a lost one is repaired by the next poll (tested) | A bell not settled comes back after the visibility timeout (tested) |
| Dead-letter queue | Dead-letter topic after 5 delivery attempts. A bell in it is a metric and is never replayed (emulator: wiring only) | Redrive after 5 receives to a dead-letter queue. A bell in it is a metric and is never replayed (emulator) | None: a bell is not a message body, so nothing can be malformed (tested) | None: an unhandled bell is redelivered (tested) |
| Queue statistics | Cloud Monitoring: about 5 minutes behind plus the cache. `inFlight` unknown, `delayed` 0. `unavailable` on the emulator (declared; real: not run) | `GetQueueAttributes`, up to about a minute stale; age from CloudWatch, about 5 minutes behind plus the cache. `unavailable` age on ElasticMQ (declared; real: not run) | Exact counts read from the store (`postgres-counts`), staleness 0 (tested) | Exact, staleness 0 (tested) |
| Authentication | Application Default Credentials; a service account with publisher and subscriber roles. None on the emulator (design; real: not run) | The default AWS credential chain (a task role); the region is explicit and never read from the machine (design; real: not run) | The database credentials only; `LISTEN` needs a direct URL, not a pooler (tested) | None (tested) |
| Cost drivers | Data volume published and delivered, a Cloud Scheduler job, Cloud Monitoring reads. Not measured (not run) | Requests: about 2.1 per job with room to receive, plus idle long polls and CloudWatch reads (emulator count; price not checked) | Database load: one poll per queue per worker per interval (tested) | None (tested) |
| Known limits | No per-message delay or backoff the application controls; retry backoff is the subscription policy (design) | 10 bells per batch; 900 s delay; a bell is one request however many jobs it stands for (declared) | A pooler in transaction mode cannot carry `LISTEN`: poll only (tested) | One process: bells never leave it (tested) |
<!-- END generated:matrix -->

## 3. Delay precision

The tick's share of a delayed job's lateness, which is what a user sees on a window-0 transport such as Pub/Sub.
SQS's window is **900 s**, declared above; a delay inside it is the broker's, rounded up to a whole second,
and a longer one is `delay-too-long` and left to the tick. The figures are the ones in
[limits.md](limits.md) section 1, measured on the emulators and local Postgres; `test/contract/matrix.test.ts`
compares the two files. **Real SQS: not measured.**

<!-- BEGIN generated:delay -->
| Mode | Figure (the same words as [limits.md](limits.md) section 1) |
| --- | --- |
| Pub/Sub, tick only on Cloud Scheduler | mean about 30 s, worst about 60 s |
| Any window-0 transport, in-process tick, interval 500 ms | mean 270-292 ms, p95 479-513 ms |
| The same, interval 2,000 ms | mean 1,080-1,113 ms, p95 1,950-1,956 ms |
| A transport with a delivery window: the tick rings ahead | mean 6-8 ms after due |
| Postgres: the poll interval | default 1,000 ms, jittered plus or minus 20 % |
| SQS: rounding of `DelaySeconds` | rounded up to a whole second |
<!-- END generated:delay -->

## 4. Emulator only

These rows hold on the emulator and say nothing about the service. A green emulator run is proof of wiring.

<!-- BEGIN generated:emulator -->
| What | How the emulator differs from the service |
| --- | --- |
| Pub/Sub emulator: retry backoff | The emulator's backoff is not exponential, so the retry curve of a nacked bell is not that of the service. |
| Pub/Sub emulator: flow control | It ignores flow control, so the `maxHeld` bound on bells a busy worker holds is not exercised. |
| Pub/Sub emulator: dead-lettering and IAM | Dead-letter wiring is checked, not the service's behaviour under real IAM; throughput is not measured. |
| ElasticMQ: receive counts | Exact on ElasticMQ; approximate on SQS (about a minute stale). `stats` says so in `source` and `maxStalenessMs`. |
| ElasticMQ: stale receipt handles | A delete of a stale handle answers `ReceiptHandleIsInvalid` and leaves the message; SQS may answer success without deleting. The transport treats both as harmless. |
| ElasticMQ: partial batch failures (`Failed[]`) | ElasticMQ returns it for a bad entry, but no bell the transport can send makes one refuse. The parsing is covered by stub-client tests; a real partial failure was never produced. |
| ElasticMQ: redrive | A message moves to the dead-letter queue as soon as it was received `maxReceiveCount` times; SQS moves it on the next receive. |
| ElasticMQ: duplicates and short receives | It never duplicates, and fills a receive to 10 when it can; a standard SQS queue does neither. |
| ElasticMQ: CloudWatch | There is none, so queue age and the dead-letter metric are tested against a stub client. |
<!-- END generated:emulator -->

## 5. Skipped behaviours

A transport that lacks a behaviour skips its test with the reason, in code, and the skip is listed here:

<!-- BEGIN generated:skips -->
| Suite | Transport | Behaviour | Why it is skipped |
| --- | --- | --- | --- |
| Contract suite | `memory` | `poison` | the in-process queue has no dead-letter queue: an unhandled bell is redelivered |
| Contract suite | `memory` | `outage` | there is no network: the queue lives in the process |
| Contract suite | `postgres-local` | `poison` | bells are notifications and store rows, not broker messages: there is no body to be malformed |
| Contract suite | `postgres-local` | `outage` | the connection is the store connection; its reconnect is tested against a killed backend in packages/transport-local/test/postgres.fault.test.ts |
| Scenario: a malformed bell: it ends in the dead-letter queue, is counted, and the jobs behind it still run | `memory` | n/a | the in-process queue has no dead-letter queue: an unhandled bell is redelivered |
| Scenario: a malformed bell: it ends in the dead-letter queue, is counted, and the jobs behind it still run | `postgres` | n/a | bells are notifications and store rows, not broker messages: there is no body to be malformed |
<!-- END generated:skips -->

Delayed-delivery tests run only where `maxDeliverDelayMs > 0`. A transport at 0 passes the same end-to-end scenario
through the tick, with its precision stated in section 3.

## 6. Open decision D2: one bell per job or per batch

**SQS: not measured; per job by default.** The choice between a bell per job and one per batch of jobs was measured
only against the local broker; a load test of both granularities on real SQS is behind `QCLOUD_REAL_CLOUD=1` and
D9, and has not been run. Until it is, every transport rings one bell per job.

## 7. Running it

```bash
bun run test:contract  --transport=local,gcp-emulator,aws-emulator
bun run test:scenarios --transport=local,gcp-emulator,aws-emulator
```

`local` is the memory and Postgres transports and needs only Postgres. `gcp-emulator` needs the Pub/Sub emulator on
`127.0.0.1:58085` and `aws-emulator` ElasticMQ on `127.0.0.1:59324` (see `CLAUDE.md`). An emulator that is down
fails the run rather than skipping it. `gcp` and `aws` are the real clouds: refused unless `QCLOUD_REAL_CLOUD=1`,
and no real-cloud stack exists until task 43.
