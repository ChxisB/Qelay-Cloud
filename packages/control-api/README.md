# @qelay-cloud/control-api

The HTTP API behind the Qelay control panel. It runs on `Bun.serve` with a small router (no framework), reads and
writes through the `StateStore`, and holds no job state of its own, so any number of instances can run side by side.

This package holds the core (the request pipeline, authentication and roles, the error model, `/health` and
`/capabilities`) and the route groups for jobs and queues, the dead-letter queue, cron, workers, live events, metrics and
the audit log. The groups still to come (flows, workflows) are added by later tasks as `Route[]` through `deps.routes`.
The API is described in [docs/openapi.yaml](../../docs/openapi.yaml); a test fails when the file and the served routes
differ.

## Use

```ts
import { controlApiOptionsFromEnv, createControlApi, listenFromEnv, startControlApi } from '@qelay-cloud/control-api';

const app = createControlApi(controlApiOptionsFromEnv(process.env, version), {
  transport: { name: 'gcp-pubsub', capabilities: transport.capabilities },
  features: { flows: false },
  readiness: postgresReadiness(db, store, reachability),
  routes: [...jobRoutes, ...queueRoutes],
});
const server = startControlApi(app, listenFromEnv(process.env));
```

`createControlApi` validates the configuration and throws `ControlApiConfigError` for one that must not run (below);
the message never repeats a secret. `app.handle(request)` answers any `Request` and never throws, which is how the tests
call it without a socket.

## Request pipeline

Each request goes through these steps in order, and a step that refuses ends it:

1. **Request ID.** A valid `X-Request-Id` is kept, otherwise one is made. It is on every response and every log line.
2. **CORS preflight** (`OPTIONS`) against the allow-list.
3. **Route match.**
4. **Authentication**, before a 404 or 405, so an unauthenticated caller learns nothing about which paths exist.
5. **404 / 405** (`Allow` is sent with a 405).
6. **Role.** A route marked `write` needs `operator`: 403 for `viewer`.
7. **Rate limit**, on `write` routes only: 429 with `Retry-After`.
8. **Body cap.** A declared `Content-Length` over the cap is 413 before the body is read; a body without one is
   counted as it streams and refused at the cap. The socket layer is given the same cap (`maxRequestBodySize`).
9. **Handler**, under a time limit: 504 when it runs out. For a `write` route the message says the outcome is unknown.

`GET /health` is the only route with no token. Everything else, `/health/ready` included, needs one.

## Authentication and roles

Two ways in, both a bearer token in the `Authorization` header:

- **OIDC JWT** (production). The signature is checked against the issuer's JWKS, with an allow-list of asymmetric
  algorithms (`RS256`, `ES256`; `none` and `HS*` are refused at startup), the `iss` and `aud` claims, a required `exp`
  and `sub`, and a clock tolerance. Keys are fetched from the JWKS URL, cached, and refetched when a token names a `kid`
  that is not cached, at most once per cooldown, so a flood of unknown `kid`s cannot hammer the issuer. A caller always
  sees a plain 401, whatever the reason; the reason (`expired`, `audience`, `unknown-key`, ...) goes to the operator's
  log. A valid token that grants no role is 403.
- **Development token** (local only). A static token of at least 24 characters, compared in constant time. **The service
  refuses to start with it when `NODE_ENV=production`** (or `production: true`), with an error that says to configure OIDC.
  Production mode cannot be turned off by an option once the environment sets it. A warning is logged when it is enabled.

The role comes from a claim (default `roles`, a string or an array, a dotted path is accepted). `operator` can do
everything; `viewer` can read. Which claim values grant which role is configurable.

**Why `jose`.** JWT verification is the part of this service where a home-made parser is most dangerous. `jose` is small,
maintained, dependency-free, standards-based and runs on Bun; the service uses its `createRemoteJWKSet` and `jwtVerify`
and nothing else of it. (The tick's Cloud Scheduler check in `@qelay-cloud/maintenance` has its own RS256 verifier
because it predates this package; it is not changed here.)

## CORS, cookies and CSRF

The allow-list is exact origins (`scheme://host[:port]`). There is no wildcard, no `null`, and no path; the service
refuses to start with one. An `Origin` that is not listed is processed without CORS headers (the browser then blocks the
response), and a preflight from one is 403. `Access-Control-Allow-Credentials` is never sent.

**The API reads no cookies and sets none.** It authenticates only from the `Authorization` header, which a browser does
not attach on its own to a cross-site request, so CSRF does not apply. Do not add cookie-based authentication without
adding CSRF protection with it.

## Errors

Every error response is `{ "error": { "code", "message", "details"? } }` with a stable snake_case `code`. Callers branch
on `code`. The core's typed errors are mapped by `toApiError` (`JOB_NOT_FOUND` to 404, `JOB_STATE`, `LEASE_LOST`, `QUEUE_PAUSED`,
`ILLEGAL_TRANSITION` and `FLOW_PROTECTED` to 409, `TRANSPORT_ERROR` to 502, `STORE_ERROR` to 503, `OPERATION_DEADLINE` and
`OUTCOME_UNKNOWN` to 504). The message and details are written in this package, never copied from a cause (the one
exception is `unsupported_option`, which relays the typed error's own message: it names an option and nothing else), so
**a stack trace, SQL text or a payload never reaches a response**. An error nobody expected is
`internal_error` with the request ID, and the log has its type and code, not its message.

## Rate limit

A token bucket per principal on `write` routes: burst 100, 20 per second. **It is per instance:** with N instances a
caller can make N times the rate, and a restart forgets every bucket. It brakes a runaway client or a stolen token; it is
not a quota. Idle buckets are dropped and the table is bounded.

## Logging

One JSON line per request: request ID, method, route pattern (never the raw path or query), status, duration, a hashed
principal. **No payload, token, query string or header value is logged.**

## Health

| Route                           | Token | Answers                                                                                                                           |
| ------------------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------- |
| `GET /health`                   | none  | Liveness from memory: `{ ok, status: "healthy", version, uptime }`. Fields the panel's connection test requires.                 |
| `GET /health/ready`, `/ready`   | any   | 200 when the database answers within 3 s, else 503. Also reports the transport's reachability and the last tick. No job data.     |

`/ready` is the path the panel probes today. The panel also probes `/healthz`, which Qelay serves unauthenticated and this
service does not; task 34 switches the panel's probe to `/health`.

## Capabilities

`GET /capabilities` returns the transport (`name`, `maxDeliverDelayMs`, `ordering`), the feature flags
(`dlq`, `cron`, `flows`, `workflows`, `webhooks`) and the panel pages that never apply here (`hidden`). The process that
builds the service declares them in `deps`; the service does not detect them, so the answer cannot disagree with the
configuration.

## Jobs and queues

Given `deps.jobs` (`{ store, transport, options? }`), the service serves the dashboard, queues, jobs, the job inspector and
add job from one `PostgresStore`. One store is one namespace, so no request can name another's queue or job. Without
`deps.jobs`, `/dashboard` and `/stats` answer 501 `not_implemented`. The paths are in [docs/openapi.yaml](../../docs/openapi.yaml).

| Group    | Routes                                                                                                                                              |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reads    | `GET /dashboard`, `/stats`, `/queues/summary`, `/queues/:q/counts`, `/queues/:q/paused`, `/dashboard/queues`, `/dashboard/queues/:q`, `/queues/:q/jobs/list` |
| Job      | `GET /jobs/:id`, `/jobs/custom/:customId`, `/jobs/:id/result`, `/jobs/:id/logs`, `/jobs/:id/children`                                               |
| Add      | `POST /queues/:q/jobs`, `/queues/:q/jobs/bulk`                                                                                                      |
| Queue    | `POST /queues/:q/pause`, `resume`, `drain`, `clean`, `obliterate`, `promote-jobs`; `PUT`/`DELETE /queues/:q/rate-limit` and `/concurrency`           |
| Job edit | `PUT /jobs/:id/data`, `/priority`, `/delay`; `POST /jobs/:id/promote`, `/progress`, `/logs`; `DELETE /jobs/:id`, `/jobs/:id/logs`                    |
| Closed   | `POST /jobs/:id/fail`, `/discard`, `/move-to-wait`, `/move-to-delayed` and `/server/*`, `/database/*`, `/backup/*`, `/fleet/*`: 501 `not_supported`  |

**Safety.** Every route that changes something needs the `operator` role. `drain`, `clean` and `obliterate` need
`{ "confirm": "<queue name>" }` and answer 400 `confirmation_required` without it. A job action takes an optional
`expectedVersion` (body, or the query for `DELETE`): the job's `version` as the caller read it. A job that has moved
on since answers 409 `version_conflict` and nothing changes. An action the job's state does not take is 409
`job_state` naming the state: data changes on any unfinished job (an active job's lease is untouched), priority and
delay on a waiting, prioritized or delayed one, and removal on any but an active one. A job a live flow parent waits on
is 409 `flow_protected`. A failed job cannot be retried from here (DESIGN.md "Parity first"). `drain`, `clean` and `obliterate` delete in batches and stop at `actionBudgetMs`:
`done: false` means call again.

**Payloads.** `data` and `returnvalue` are JSON, with `{"$type": "bigint" | "date" | "bytes" | "map" | "set" | "number" |
"undefined", ...}` for what JSON cannot carry. A payload over the budget (1 KiB in a list, 256 KiB in a job's own
response) is `{"$type":"truncated","kind","length","preview","maxBytes"}` and the job says `truncated: true`. A body to
add or edit a job decodes the same tags.

**Bounds.** A list is at most `maxPageSize` jobs (500). `offset` goes to 100,000, and `cursor` (the `next` of the last
page, `states=` one state) goes on from there; `/dashboard/queues` stops at offset 10,000. `/queues/summary` is a bare
array of at most 1,000 queues, with `X-Next-Cursor` when more follow. `/dashboard`, `/stats` and the plain summary are kept
for `summaryCacheMs` (2 s) per instance, and `X-Qelay-Cache: bypass` reads fresh. A job's `timeline` is its creation and
at most 19 of its newest attempts, because the panel's inspector rejects more than 20.

**Options** are not read from the environment: the process that builds the service passes `jobs.options`
(`listPayloadBytes`, `detailPayloadBytes`, `maxPageSize`, `defaultPageSize`, `summaryCacheMs`, `maxBulkJobs`,
`bulkBodyBytes`, `maxOffset`, `actionBudgetMs`). Task 37 maps environment variables onto them.

## DLQ, cron, workers, events, metrics and audit

Served from the same `deps.jobs` store as the group above (task 32), and answering 501 `not_implemented` without it. A
change needs the `operator` role and leaves an audit entry; a read needs any role.

| Group    | Routes                                                                                                                                         |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| DLQ      | `GET /queues/:q/dlq`, `/queues/:q/dlq/stats`; `POST /queues/:q/dlq/purge`                                                                      |
| Settings | `GET`/`PUT /queues/:q/stall-config` and `/queues/:q/dlq-config`                                                                                |
| Cron     | `GET /crons`, `GET`/`PUT`/`DELETE /crons/:name`, `POST /crons`                                                                                 |
| Workers  | `GET /workers`, `DELETE /workers/:id`                                                                                                          |
| Events   | `GET /events`, `GET /events/queues/:q` (server-sent events)                                                                                    |
| Metrics  | `GET /metrics`, `GET /metrics/queues/:q`, `GET /ping`, `GET /storage`                                                                          |
| Audit    | `GET /audit` (operator)                                                                                                                        |
| Closed   | `POST /queues/:q/dlq/retry`, `/queues/:q/dlq/:jobId/retry`, a change to DLQ retention or auto-retry, and `/gc`, `/heapstats`, `/prometheus`: 501 |

**DLQ.** An entry is the failed job (the shape of the job inspector), when it entered, the reason, the last error and
`expiresAt` (`enteredAt + maxAge`, null when the queue keeps entries without an age limit). Lists are paged like the
others (500, `offset` capped, 400 `offset_too_large` past it). `purge` needs `{ "confirm": "<queue name>" }`, deletes in
batches for at most `actionBudgetMs` and answers `{ count, done }`; `done: false` means call again. Retry is closed (task
14 (k)): it answers 501 `not_supported` and `GET /capabilities` lists `dlq-retry` under `unsupported`, so the panel can
hide the button and not discover it by failing.

**Settings.** The stall configuration has one setting that can change, `maxStalls`; the panel's other fields are read
back as they are (the interval is the lease length) and a request that changes one is 400 `unsupported_option` naming
it. DLQ settings read back `autoRetry`, `autoRetryInterval`, `maxAutoRetries`, `maxAge` and `maxEntries`; saving them as
they are is accepted, and a change to retention (`dlq-retention`) or auto-retry (`dlq-auto-retry`) is 501.

**Cron.** The body is the panel's `CreateCronBody` with unknown keys refused by name. `schedule` takes the expressions
Qelay takes (five or six fields, names, `@hourly`, `@daily`, `@weekly`) with an optional IANA `timezone`; `repeatEvery`
takes an interval in milliseconds. A bad expression, an unknown zone, both or neither of the two, a `maxLimit` out of
range and a `dedup` without a `uniqueKey` or `preventOverlap` are 400 `unsupported_option` naming the option. `POST`
answers 201 for a new cron and 200 for one it replaced, and a replace keeps `executions` and moves `nextRun` only when
the timing changed. A template's `maxAttempts` is the store's `attempts`. `skipMissedOnRestart: false` is 400: a missed
occurrence is skipped, never made up. `data` is stored and not returned. A list is at most 1,000 crons, with
`truncated`. `lastRun` is not stored: the panel has no field for it, and `executions` and `nextRun` say what ran and what
runs next.

**Workers.** `{ ok, data: { workers, stats } }` as the panel reads it. A worker is `active` for 30 s after its last
heartbeat, then `stale`, and the tick removes it after 90 s. `DELETE` of a worker that is gone answers 200 with
`removed: false`: gone is not an error. `currentJob` is always null: the registry does not know which job a worker holds.

**Events.** `GET /events` (all queues) or `GET /events/queues/:q` streams the store's event journal as server-sent events.
Each frame's `id` is the journal position (`<commitSeq>.<eventId>`), so a client that reconnects with `Last-Event-ID`
(or `?cursor=`, the header wins) gets what it missed, once, in commit order, and never a gap, even under concurrent
writers. The stream starts with `retry: 2000`, an `id:` of where it begins and `{"connected":true}`. Events are `job:<type>`
(`pushed`, `duplicated`, `updated`, `promoted`, `priority`, `removed`, `pulled`, `released`, `completed`, `retried`,
`stalled`, `failed`, `progress`) with `{ queue, jobId, type, state, timestamp, error?, progress? }`, and
`queue:obliterated`. `?types=` keeps some of them. A client that fell behind the journal's retention (24 h) gets one
`resync` frame, `{"reason":"events_pruned"}`, and goes on from the oldest event kept. A position that is not ours is 400
`invalid_cursor` and one past the end is 409 `cursor_ahead`; both are statuses the panel reads as "forget the
checkpoint".

The stream is bounded on every side (`jobs.options.events`): a keep-alive comment every `heartbeatMs` (15 s), a close after
`maxLifetimeMs` (10 min) so a client reconnects through the load balancer, `maxPerPrincipal` streams for one caller (10,
else 429 `too_many_streams` with `Retry-After`) and `maxStreams` for the instance (200, else 503), a buffer of
`bufferBytes` (256 KiB) and a client that has not read for `slowClientMs` (30 s) while it is full is dropped. The journal
is not read ahead of a client's buffer, so a stalled socket holds at most one buffer and one page. A read the journal
fails ends the stream with a comment and the client resumes. There is no wake-up from the transport: an idle stream polls
the journal every `pollMs` (1 s), so one instance's read load is at most `maxStreams / pollMs` reads a second.

**Metrics.** `GET /metrics` is the panel's four totals. `GET /metrics/queues/:q?minutes=&resolution=&until=` is the jobs
completed and failed per minute (`resolution` 1, 5, 15 or 60 minutes, `minutes` up to `maxMetricsMinutes`, 1,440), dense
and oldest first, with the lifetime totals. Latency and wait-time percentiles are not recorded and so are not served.

**Audit.** Every request that changes something writes a row before the handler runs and closes it with the outcome
after: `success` (below 400), `rejected` (a 4xx, with its error code as the reason) or `failed` (5xx). A change that
cannot be recorded is not made (503 `audit_unavailable`). A caller the role check or the rate limit refuses is recorded as
`rejected`. A row holds who (`subject`, `role`, `source`), what (`action`, the route template) and which (`target`, the path
parameters and the name of what a body creates), the request id, the status and the times, never a payload, a query
string or a token. Unauthenticated calls and unknown routes are not recorded. Rows are kept 90 days or 100,000, and
`GET /audit?limit=&before=&subject=&action=&outcome=` pages them newest first.

## Configuration

`controlApiOptionsFromEnv` reads these. A secret comes from the environment or the cloud secret manager, never a flag.

| Variable                                                  | Meaning                                                                          |
| --------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `NODE_ENV`                                                | `production` puts the service in production mode.                                |
| `QCLOUD_API_OIDC_ISSUER`, `_AUDIENCE`, `_JWKS_URL`        | All three or none. `_AUDIENCE` is a comma list. The JWKS URL must be https.      |
| `QCLOUD_API_OIDC_ALGORITHMS`                              | Default `RS256,ES256`.                                                           |
| `QCLOUD_API_OIDC_CLOCK_TOLERANCE_SEC`                     | Default 30.                                                                      |
| `QCLOUD_API_ROLE_CLAIM`                                   | Default `roles`.                                                                 |
| `QCLOUD_API_OPERATOR_ROLES`, `QCLOUD_API_VIEWER_ROLES`    | Comma lists of claim values. Defaults `operator` and `viewer`.                   |
| `QCLOUD_API_DEV_TOKEN`, `QCLOUD_API_DEV_TOKEN_ROLE`       | Local only. At least 24 characters. Role default `operator`.                     |
| `QCLOUD_API_CORS_ORIGINS`                                 | Comma list of exact origins. Default none.                                       |
| `QCLOUD_API_MAX_BODY_BYTES`                               | Default 2 MiB.                                                                   |
| `QCLOUD_API_REQUEST_TIMEOUT_MS`                           | Default 30000.                                                                   |
| `QCLOUD_API_RATE_LIMIT_BURST`, `QCLOUD_API_RATE_LIMIT_PER_SECOND` | Defaults 100 and 20. `0` turns the limit off.                            |
| `QCLOUD_API_HOST`, `QCLOUD_API_PORT`                      | Default `127.0.0.1` and `8080`.                                                  |

A service with neither OIDC nor a development token refuses to start.

## Adding a route group

A group is a function that returns `Route[]` and is passed in `deps.routes`:

```ts
{ method: 'POST', path: '/queues/:queue/pause', access: 'write', handle: async (context) => { ... } }
```

`access` is `read` or `write` (`public` is reserved for `/health`). A handler returns a value (sent as JSON), a `Response`,
or nothing (204), and throws an `ApiError` for what it knows. `context.json(schema)` and `context.query(schema)` validate
with zod and answer 400 for input that does not fit. A route may set its own `maxBodyBytes` and `timeoutMs` (a bulk
route needs both). Registering the same method and path twice throws at startup. Add the paths to
[docs/openapi.yaml](../../docs/openapi.yaml) in the same change.

## Tests

```bash
bun test packages/control-api
```

`test/contract/` holds a verbatim copy of the panel's response types (`shapes/panel-types.ts`, with the panel commit in
its header) and checks that what the service sends fits them, at compile time and at run time. One known deviation:
the panel types a not-ready `/ready` body's `storage.diskFull` as the literal `true`; this service sends `false`, because
it does not report a full disk. A panel that reads only `storage.error` (the one in the repository today) is unaffected,
and task 34 corrects the panel's type.
