# Configuration reference

Every Qelay-Cloud process is configured from its environment, and only from there: a flag would show in the process
list, and one place keeps the contract short. A setting that cannot work, or is unsafe, stops the process before it
connects (exit code 2) and the message names the variable and never repeats its value.

`bun run docs:check` fails when this page and the code disagree: a variable the code reads and this page does not list,
or one listed here that no code reads. Defaults below are the ones in the code; "none" means the setting is off or absent
when unset. Durations are milliseconds and every number is a non-negative integer unless a row says otherwise.
Names from the tick, the Control API and the panel that are not `QCLOUD_*` (`PORT`, `NODE_ENV`) are listed with their
process.

Which process reads what:

| Process | Command | Reads |
| --- | --- | --- |
| Control API | `qcloud-api serve`, `qcloud-api migrate` | [Shared](#shared), [Database](#database), [Control API](#control-api), [Webhooks](#webhooks) (the key and address policy), the workflow rows marked API |
| Tick | `qcloud-tick run`, `qcloud-tick serve`, `qcloud-tick send` | [Shared](#shared), [Database](#database), [Tick](#tick), [Webhooks](#webhooks), [Workflows](#workflows) |
| Panel | `packages/panel/serve/main.ts` | [Panel](#panel) only |
| Your workers | the SDK in your code | the connection settings you pass to it; the SDK does not read `QCLOUD_*` |

## Shared

| Variable | Default | Meaning |
| --- | --- | --- |
| `QCLOUD_NAMESPACE` | `default` | The namespace every read and write is scoped to. Processes that share jobs (workers, tick, Control API) must use the same one; two deployments on one database use different ones. |
| `QCLOUD_SHARDS` | none | Several databases: `namespace=shard` pairs, comma separated (`acme=a,globex=b`). Shard names are lower-case letters and digits. With it set, `QCLOUD_DATABASE_URL` is refused and each shard needs its own URL (below); a namespace not listed is refused. See [operations.md](../operations.md#shards). |
| `QCLOUD_SHARD_<NAME>_DATABASE_URL` | none | The connection string of shard `<NAME>` (upper case): `QCLOUD_SHARD_A_DATABASE_URL` for shard `a`. Any other `QCLOUD_DATABASE_*` variable can be given as `QCLOUD_SHARD_<NAME>_DATABASE_*` to override the shared value for that shard. A process reads only the shard it opens. |
| `QCLOUD_TRANSPORT` | `gcp-pubsub` | The broker that carries the doorbell: `gcp-pubsub`, `aws-sqs` or `postgres` (the local transport: no broker, the store is polled; for development and tests). |
| `QCLOUD_GCP_PROJECT` | none | The Google Cloud project of the Pub/Sub transport. |
| `QCLOUD_GCP_HOT_QUEUES` | none | Comma-separated queue names that have their own Pub/Sub topic and an unfiltered subscription. Every process (API, tick, workers) must be given the same list as `ensureQueue` and the Terraform `hot = true`. See [limits](../limits.md#11-cost-of-the-doorbell-on-sqs-task-40). |
| `QCLOUD_AWS_REGION` | none | The AWS region of the SQS transport. **Required** with `aws-sqs`: the region is never guessed from the machine. |
| `QCLOUD_AWS_SQS_ENDPOINT` | none | An SQS-compatible endpoint, for ElasticMQ or LocalStack. Leave unset on AWS. |

Cloud credentials are not settings: the Google and AWS client libraries find them from the platform (the service
account of the Cloud Run service, the task role of the ECS task). Nothing in this page takes one.

## Database

Postgres is the authoritative store. All three processes use the same variables. The URL is a secret: set it from the
cloud secret manager, never in a file in the repository.

| Variable | Default | Meaning |
| --- | --- | --- |
| `QCLOUD_DATABASE_URL` | none, **required** | The Postgres connection string. |
| `QCLOUD_DATABASE_POOLER` | `none` | `transaction` when the URL goes through a transaction-mode pooler (PgBouncer, RDS Proxy, Supavisor). The driver then turns off named prepared statements and does not set session options a pooler would lose. |
| `QCLOUD_DATABASE_LISTEN_URL` | none | A direct (non-pooled) URL for `LISTEN`. Required to listen when the main URL goes through a pooler, and refused without one: with no pooler `LISTEN` uses the main URL. |
| `QCLOUD_DATABASE_POOL_SIZE` | `2` | Connections one process may open. The [connection budget](../operations.md#connection-budget) counts this number. |
| `QCLOUD_DATABASE_SCHEMA` | none | Run in this schema. Direct connections only: behind a pooler set the role's `search_path` instead. |
| `QCLOUD_DATABASE_TLS` | none | `unverified` encrypts without checking the certificate; `off` uses no TLS. Conflicts with the two CA variables. |
| `QCLOUD_DATABASE_TLS_CA_FILE` | none | Path to the PEM of the CA to trust. TLS is then verified. |
| `QCLOUD_DATABASE_TLS_CA` | none | The same PEM as text, for a platform that can inject variables but not mount a file. |

Set at most one of the three. With none of them the connection is allowed only to a loopback host or a unix socket (the Cloud SQL socket is encrypted by the connector); any other host must choose, so a plaintext connection is always said out loud. `ssl`, `sslmode` and the other `ssl*` URL parameters are refused, because `sslmode=require` would encrypt without verifying the server.

## Control API

`qcloud-api serve` listens on `QCLOUD_API_HOST:QCLOUD_API_PORT`. It needs either OIDC or the development token to start.
[Routes](routes.md) lists what it serves; [openapi.yaml](../openapi.yaml) is the contract.

### Listening and sign-in

| Variable | Default | Meaning |
| --- | --- | --- |
| `QCLOUD_API_HOST` | `127.0.0.1` | Interface to listen on. Behind Cloud Run or an ECS load balancer set `0.0.0.0`. |
| `QCLOUD_API_PORT` | `8080` | Port to listen on. |
| `QCLOUD_API_DEV_TOKEN` | none | A static bearer token of at least 24 characters, for local development. **Refused when `NODE_ENV=production`.** |
| `QCLOUD_API_DEV_TOKEN_ROLE` | `operator` | The role the development token gets: `viewer` or `operator`. |
| `QCLOUD_API_DEV_TOKEN_ALLOW_NETWORK` | `false` | `true` lets the process hold a development token while listening beyond loopback (a private development network). Without it that combination is refused. |
| `QCLOUD_API_OIDC_ISSUER` | none | The token issuer (`iss`). Setting any of the three OIDC variables makes all three required. |
| `QCLOUD_API_OIDC_AUDIENCE` | none | Accepted audiences (`aud`), comma separated. |
| `QCLOUD_API_OIDC_JWKS_URL` | none | Where the issuer publishes its signing keys. |
| `QCLOUD_API_OIDC_ALGORITHMS` | `RS256,ES256` | Accepted signature algorithms. `none` and `HS*` are refused. |
| `QCLOUD_API_OIDC_CLOCK_TOLERANCE_SEC` | `30` | Allowed clock skew, in seconds. |
| `QCLOUD_API_ROLE_CLAIM` | `roles` | The claim that carries the caller's roles. |
| `QCLOUD_API_OPERATOR_ROLES` | `operator` | Role names that grant the `operator` role (every change). Comma separated. |
| `QCLOUD_API_VIEWER_ROLES` | `viewer` | Role names that grant the `viewer` role (read only). Comma separated. |
| `QCLOUD_API_CORS_ORIGINS` | none | Origins allowed to call the API from a browser, comma separated. A wildcard is refused. Unset: no cross-origin access. |
| `NODE_ENV` | none | `production` switches on the stricter checks above. |

### Limits

| Variable | Default | Meaning |
| --- | --- | --- |
| `QCLOUD_API_MAX_BODY_BYTES` | `2097152` | Largest request body (2 MiB). A bulk add has its own, larger bound. |
| `QCLOUD_API_REQUEST_TIMEOUT_MS` | `30000` | Longest a request may take. |
| `QCLOUD_API_RATE_LIMIT_BURST` | `100` | Requests one caller may make at once. `0` turns the limit off. |
| `QCLOUD_API_RATE_LIMIT_PER_SECOND` | `20` | Requests per second one caller may keep up. `0` turns the limit off. |
| `QCLOUD_API_MAX_PAGE_SIZE` | `500` | Largest `limit` of a list. |
| `QCLOUD_API_SUMMARY_CACHE_MS` | `2000` | How long the dashboard, queue summary and stats answers are kept. `0` turns the cache off; a request with `x-qelay-cache: bypass` skips it. |
| `QCLOUD_API_ACTION_BUDGET_MS` | `20000` | How long one drain, clean or obliterate keeps deleting before it answers `done: false` and leaves the rest to another call. At most 120,000. |
| `QCLOUD_API_SHUTDOWN_GRACE_MS` | `8000` | How long a stopping process lets requests finish. At most 60,000; Cloud Run kills at ten seconds. |

### Live events (`GET /events`)

| Variable | Default | Meaning |
| --- | --- | --- |
| `QCLOUD_API_EVENTS_POLL_MS` | `1000` | How often an idle stream looks for new events. Each open stream is one read per interval. At most 60,000 and not above the heartbeat. |
| `QCLOUD_API_EVENTS_HEARTBEAT_MS` | `15000` | A comment line this often keeps proxies quiet. At most 60,000. |
| `QCLOUD_API_EVENTS_MAX_LIFETIME_MS` | `600000` | A stream ends after this long so the client reconnects and signs in again. |
| `QCLOUD_API_EVENTS_MAX_PER_PRINCIPAL` | `10` | Streams one caller may hold open (`429` past it). |
| `QCLOUD_API_EVENTS_MAX_STREAMS` | `200` | Streams one instance may hold open (`503` past it). |

### Deployment page

The `/deployment` and `/transport` routes report on the running system. These settings tell them what to expect.

| Variable | Default | Meaning |
| --- | --- | --- |
| `QCLOUD_VERSION` | `0.0.0` | The version `/health` reports. The image build sets it. |
| `QCLOUD_COMMIT` | none | The commit `/deployment` reports. The image build sets it. |
| `QCLOUD_API_TICK_LATE_AFTER_MS` | `60000` | A tick older than this is shown as late. |
| `QCLOUD_API_TICK_STALE_AFTER_MS` | `300000` | A tick older than this is shown as stale (the scheduler is probably not running). |
| `QCLOUD_API_DEPLOYMENT_CACHE_MS` | `2000` | How long the `/transport` and `/deployment` answers are kept. `0` turns the cache off. |
| `QCLOUD_API_TRANSPORT_MAX_QUEUES` | `50` | Queues `/transport` reports on at most; the rest are counted in `truncated`. |
| `QCLOUD_FLEET_WORKERS` | none | Worker processes you run. Setting it lets `/deployment` set connection use against the [budget](../operations.md#connection-budget). The four variables below need it. |
| `QCLOUD_FLEET_POOL_SIZE` | the SDK's | Connections each worker may open. |
| `QCLOUD_FLEET_LISTENERS` | none | Processes that hold a `LISTEN` connection. |
| `QCLOUD_FLEET_CONTROL_PROCESSES` | the budget's | Control API and tick processes. |
| `QCLOUD_FLEET_POOLER_POOL_SIZE` | the budget's | Server connections the pooler may open. The fleet is taken to use the pooler when `QCLOUD_DATABASE_POOLER` is `transaction`. |

### Workflows (Control API)

| Variable | Default | Meaning |
| --- | --- | --- |
| `QCLOUD_API_WORKFLOWS` | `true` | `false` hides the Workflows page and refuses its routes. Unset or `true` leaves it to the schema. |
| `QCLOUD_API_WORKFLOW_SERVED_MS` | `120000` | A workflow definition counts as served while a worker announced it this recently. Workers announce every 30 s. |

The engine queue and the idle window the API acts with are the tick's own, read by the same names:
`QCLOUD_WORKFLOW_QUEUE` and `QCLOUD_WORKFLOW_IDLE_MS` below. Set them identically on both.

## Tick

`qcloud-tick run` is one invocation, for a scheduler that starts a job; `qcloud-tick serve` answers
`POST /internal/tick` for Cloud Scheduler or EventBridge. Both also read the shared, database, webhook and workflow
settings. [Concepts](../concepts.md#the-maintenance-tick) says what a tick does; [limits.md](../limits.md) section 7
derives the bounds.

| Variable | Default | Meaning |
| --- | --- | --- |
| `QCLOUD_SHARD` | none | `qcloud-tick loop` only: tick every namespace of this shard, one loop each, over one pool. Needs `QCLOUD_SHARDS`; excludes `QCLOUD_NAMESPACE`; `run`, `serve`, `send` and `webhook-writer` refuse it. |
| `QCLOUD_TICK_INTERVAL_MS` | `60000` | The longest gap between two ticks you promise: the scheduler's period. (The in-process loop of the SDK's local setup defaults to 5,000.) |
| `QCLOUD_TICK_RE_RING_AFTER_MS` | the interval | A claimable job whose last bell is this old is rung again. At most the interval. |
| `QCLOUD_TICK_RING_GRACE_MS` | `2000` | A job created this recently with no bell yet is left alone: its publish may be in flight. |
| `QCLOUD_TICK_WORST_LATENESS_MS` | `1000` | How late a tick may start. Part of the ring window's floor. |
| `QCLOUD_TICK_RING_WINDOW_MS` | interval + lateness | How far ahead a delayed job is rung. `0` rings it only once due. Otherwise at least interval plus lateness, and clamped to what the transport can hold. |
| `QCLOUD_TICK_MAX_RINGS_PER_QUEUE` | `100` | Most bells per queue in one pass. |
| `QCLOUD_TICK_MAX_STALE_RINGS_PER_QUEUE` | the value above | Most of those that go to jobs already rung once, whose bell has aged past the re-ring threshold. Lower it (10, say) so a deep, healthy backlog is not rung again in full each interval; never-rung jobs keep the full cap. |
| `QCLOUD_TICK_MAX_ITEMS` | `200` | Most items per step of one pass. |
| `QCLOUD_TICK_MAX_PASS_MS` | `5000` | Wall-clock budget of one pass; the steps after it are skipped. |
| `QCLOUD_TICK_MAX_RUN_MS` | `20000` | Wall-clock budget of one invocation; passes repeat while there is more work. |
| `QCLOUD_TICK_UPKEEP_EVERY_MS` | `0` (`30000` for `qcloud-tick loop`) | For a process that beats often: the retention steps (DLQ, workers, webhook deliveries, events, completions, metric buckets) run once per this many ms and the beats between do recovery, crons, promotion, expiry and the rings. `0` runs them on every beat. Per process: after a change of leader the new one runs them on its first beat. |
| `PORT` | `8080` | The port `serve` listens on. |
| `QCLOUD_TICK_HOST` | `0.0.0.0` | The interface `serve` listens on. |
| `QCLOUD_TICK_AUDIENCE` | none | `serve` accepts a Google-signed identity token with this audience, from the emails in the next row. Cloud Scheduler sends one. |
| `QCLOUD_TICK_ALLOWED_EMAILS` | none | Comma separated verified emails (the scheduler's service account) allowed to call the endpoint. |
| `QCLOUD_TICK_SHARED_SECRET` | none | A shared secret instead of the token, for development only. `serve` refuses to start with neither this nor the audience. |

## Webhooks

The tick sends the deliveries (`qcloud-tick send` is the sender alone, for volume); a namespace's deliveries are made by the job's transaction, or by a writer once `qcloud-tick webhook-writer on` has switched it (no variable: a webhook's `filter` and `shape` need it); the Control API and the tick both read the key and the address policy, so set those two
identically on both. [webhooks.md](../webhooks.md) is the full design.

| Variable | Default | Meaning |
| --- | --- | --- |
| `QCLOUD_WEBHOOK_KEY` | none | 32 bytes as 64 hex digits or base64: the key webhook secrets are sealed with. Without it a webhook cannot be given a secret. Keep it in the secret manager, apart from the database. |
| `QCLOUD_WEBHOOK_DEV_MODE` | `false` | `true` allows `http:` and loopback or private destinations. Anything else keeps the strict policy: `https:` and public addresses only. |
| `QCLOUD_WEBHOOK_BATCH` | `50` | Deliveries one pass sends at most. `0` sends nothing. |
| `QCLOUD_WEBHOOK_CONCURRENCY` | `8` | Requests in flight at once. |
| `QCLOUD_WEBHOOK_BUDGET_MS` | `5000` | No new chunk of requests starts after this much of a pass. |
| `QCLOUD_WEBHOOK_TIMEOUT_MS` | `10000` | The bound on one attempt, name lookup to answer. |
| `QCLOUD_WEBHOOK_LEASE_MS` | `30000` | How long a claimed delivery is its sender's. At least the timeout plus 5,000, or a slow receiver is sent to twice. |
| `QCLOUD_WEBHOOK_RATE_PER_MINUTE` | `60` | Attempts one webhook gets in a minute. |
| `QCLOUD_WEBHOOK_KEEP_MS` | `172800000` | How long a finished delivery stays readable (two days). A day of deliveries is dropped whole once its end is this old. With several ticks on one database the shortest value decides. |
| `QCLOUD_WEBHOOK_MAX_ATTEMPTS` | `8` | Attempts per delivery, the first included. |
| `QCLOUD_WEBHOOK_DISABLE_AFTER` | `20` | Failed deliveries (every attempt used) in a row after which a webhook is paused; alert levels come at 50, 70, 90 and 100% of it. `0`: never pause. |
| `QCLOUD_WEBHOOK_BASE_DELAY_MS` | `30000` | The wait after the first failure; each further failure doubles it. |
| `QCLOUD_WEBHOOK_MAX_DELAY_MS` | `3600000` | The longest wait between two attempts. |
| `QCLOUD_WEBHOOK_KEEPALIVE_MS` | `15000` | `qcloud-tick send` only. How long a connection to a receiver is kept for the next delivery. `0`: one connection per delivery. |
| `QCLOUD_WEBHOOK_DNS_TTL_MS` | `30000` | `qcloud-tick send` only. How long a name's addresses are kept. `0`: a lookup per delivery. |
| `QCLOUD_WEBHOOK_PER_DESTINATION` | `4` | `qcloud-tick send` only. Requests in flight to one host and port. |
| `QCLOUD_WEBHOOK_BREAKER_FAILURES` | `5` | `qcloud-tick send` only. Failed attempts in a row after which a host and port is paused. `0`: never. |
| `QCLOUD_WEBHOOK_BREAKER_COOLDOWN_MS` | `30000` | `qcloud-tick send` only. How long a paused destination is left alone before one attempt tries it. |
| `QCLOUD_WEBHOOK_IDLE_MS` | `500` | `qcloud-tick send` only. The wait before asking the store again when nothing is due. |
| `QCLOUD_WEBHOOK_RESPONSE_BYTES` | `1024`; `0` with `QCLOUD_WEBHOOK_DEV_MODE` | Bytes of a failed answer's body kept as `response` in the attempt's history (at most 4096). `0`: none. |
| `QCLOUD_WEBHOOK_USER_AGENT` | `qelay-cloud-webhooks/1` | The `User-Agent` of a delivery request: printable ASCII, at most 100 characters. |

The defaults are eight attempts over about 63 minutes.

## Workflows

The tick's workflow step starts timed waits, recovers stalled runs and closes finished ones.
[limits.md](../limits.md) section 13 has the bounds.

| Variable | Default | Meaning |
| --- | --- | --- |
| `QCLOUD_WORKFLOW_QUEUE` | `__wf:steps` | The engine's queue. Must be the engine's `queueName`, and the same on the Control API. |
| `QCLOUD_WORKFLOW_BATCH` | `100` | Overdue waits, and stuck runs, one pass handles at most, each. `0` turns the step off. |
| `QCLOUD_WORKFLOW_IDLE_MS` | `300000` | A run with no progress for this long is taken by recovery. Must exceed the engine's heartbeat gap. The Control API uses the same value, so an operator never takes a run the engine is still writing. |
| `QCLOUD_WORKFLOW_WAIT_LEASE_MS` | `30000` | How long an overdue wait that one tick claimed is that tick's before another tick may claim it again. |

## Panel

The panel is static files plus a small server that serves them and the public settings at `/config.json`. Nothing here is
secret; the panel holds no credentials of its own.

| Variable | Default | Meaning |
| --- | --- | --- |
| `QCLOUD_PANEL_API_BASE_URL` | none, **required** | The Control API the panel talks to. `https`, or `http` on localhost. |
| `QCLOUD_PANEL_AUTH_MODE` | `oidc` | `oidc` (sign in with your identity provider) or `token` (paste a bearer token; for development). |
| `QCLOUD_PANEL_OIDC_AUTHORITY` | none | The identity provider's URL. Required with `oidc`. |
| `QCLOUD_PANEL_OIDC_CLIENT_ID` | none | The panel's client id. Required with `oidc`. |
| `QCLOUD_PANEL_OIDC_SCOPE` | `openid profile` | Scopes to ask for. |
| `QCLOUD_PANEL_OIDC_AUDIENCE` | none | Audience to ask for, where the provider needs it. The Control API accepts only the audiences in `QCLOUD_API_OIDC_AUDIENCE`. |
| `QCLOUD_PANEL_BASE_PATH` | `/` | Where the panel is mounted, such as `/panel`. |
| `QCLOUD_PANEL_CSP_CONNECT_EXTRA` | none | Extra `https` origins the page may connect to (an identity provider's token endpoint on another host), space separated. |
| `QCLOUD_PANEL_HOST` | `127.0.0.1` | Interface to listen on. In a container set `0.0.0.0`. |
| `QCLOUD_PANEL_PORT` | `8080` | Port to listen on. |
| `QCLOUD_PANEL_DIST` | `../dist` next to the server | The built panel to serve (`bun run --cwd packages/panel build`). |
