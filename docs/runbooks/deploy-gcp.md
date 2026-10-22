# Runbook: deploy the control plane on GCP

The Control API, the panel and the migration job, as Cloud Run in the project the data plane
([infra/gcp/example](../../infra/gcp/example)) already lives in. Terraform is in
[infra/gcp/control-plane](../../infra/gcp/control-plane); the images are built from
[packages/control-api/Dockerfile](../../packages/control-api/Dockerfile) and
[packages/panel/Dockerfile](../../packages/panel/Dockerfile).

**Status: written, planned and smoke-tested locally; never applied.** Applying creates paid, shared resources and needs
the go-ahead of decision D9. What was and was not run is at the end ([What has never run](#what-has-never-run)).

## What is deployed

```
                 internet                                    VPC (the data plane's subnet)
 browser ─► <name>-panel (static, /config.json) ┐
         ─► <name>-api ── OIDC token checked ───┼─► Cloud SQL (private IP)         <name>-tick ◄── Cloud Scheduler
                                                │   Pub/Sub (publish, peek DLQ)    <name>-worker(s)
 release ─► <name>-migrate (Cloud Run Job) ─────┘   Cloud Monitoring (read)
```

| Piece | Where | Runs |
| --- | --- | --- |
| Workers, tick, scheduler, database, topics | data plane (`infra/gcp/example`) | already there; the tick is the **same image** as the API with its entrypoint overridden (`tick_command`) |
| `<name>-api` | control plane | `qcloud-api serve` |
| `<name>-panel` | control plane | the panel's static build and the server that makes `/config.json` |
| `<name>-migrate` | control plane (Cloud Run Job) | `qcloud-api migrate`, once per release |

The control plane is a separate Terraform root. It is applied every release; the data plane rarely. They meet at one
output, `control_plane_inputs`, which holds identifiers and secret references and never a secret value.

## Decisions

### Exposure: public HTTPS with sign-in at the application (the default)

`exposure = "public"`. Both services answer on their `run.app` URLs to the internet. Cloud Run's own IAM check is off
(`allUsers` holds `roles/run.invoker`), and **the API refuses every request that has no valid token. `/health` is the
only route without one**, and it touches nothing and says nothing about jobs. The panel's server serves static files and
`/config.json`, which holds no secret by construction (a strict schema, tested).

Why this one: the panel is a browser app and its users sign in with their own provider; the API holds no secret and no
user list, it checks a signed token (issuer, audience, expiry, algorithm RS256 or ES256, roles claim). That works with
any OIDC provider, needs no load balancer, no certificate and no extra product, and adds nothing to the monthly bill.

| Mode | When | What changes |
| --- | --- | --- |
| `public` (default) | most teams | as above |
| `private` | the panel is only used from the VPC (a VPN, an internal load balancer, a jump host) | `ingress = INTERNAL_ONLY`. The token check stays. Nothing outside the VPC reaches either service, so the browser must be inside it. |
| `public` + `edge` | you want a rate limit that counts per client address across every instance, before a request reaches one | `edge = { api_hostname, panel_hostname, rate_limit_per_minute }` adds an external HTTPS load balancer, a Google-managed certificate and a Cloud Armor rate rule (429 over the limit), and sets `ingress = INTERNAL_LOAD_BALANCER` so the `run.app` URLs stop answering the internet. The two host names are yours: point DNS at `edge.ip_address`, and re-register the `oidc_redirect_uris` (they now name the host names). Only HTTPS is served. Billed separately from Cloud Run (load balancer, policy, rule, requests). Off by default; the plan is checked, never applied or run against a real project (D9). |
| IAP | the organisation requires Google identity at the edge | **Not in this Terraform.** The google provider (6.50) has no `iap_enabled` on `google_cloud_run_v2_service`; IAP needs a serverless NEG behind an external HTTPS load balancer, a certificate and a domain, which is a different shape. Use `private` ingress behind that load balancer and keep the application's token check: IAP then identifies the person at the edge and the API still authorizes by role. |

If the organisation's policy blocks `allUsers` (domain-restricted sharing), the apply fails on the invoker binding. The
service-level switch `invoker_iam_disabled = true` on the two services does the same job without `allUsers`; it is the
only change needed, and it is not set by default because it removes a layer where `allUsers` keeps one.

### Sign-in

Any OIDC provider that publishes a JWKS. The panel is a public client (authorization code with PKCE, no secret).
Register the panel's client and give it the redirect URIs from the `oidc_redirect_uris` output (they are computed from the
panel's URL). The token the panel sends to the API must carry:

- `iss` equal to `oidc_issuer`, `aud` containing one of `oidc_audience` (if your provider needs an `audience` parameter
  on the authorize request, set `oidc_token_audience`);
- the roles in the claim `role_claim` (default `roles`; a dotted path such as `realm_access.roles` works; the value is an
  array or a space-separated string): any of `operator_roles`
  (default `operator`) grants writes, any of `viewer_roles` (default `viewer`) grants reads. A valid token with neither is
  403, not 401.

Access tokens must be JWTs signed RS256 or ES256. An opaque token cannot be checked offline and is refused.

## Environment

Every setting is an environment variable; Terraform sets all of them, and the table is the documentation of what each
one means. No secret is in a plain environment variable: the database URL is a Secret Manager reference, and the CA
certificate is a mounted file.

### API (`qcloud-api serve`)

| Variable | Set to | Meaning |
| --- | --- | --- |
| `QCLOUD_DATABASE_URL` | secret reference | The database URL (the pooler's, when there is one). Required. |
| `QCLOUD_DATABASE_POOL_SIZE` | `api_pool_size` (2) | Connections per instance; the data plane's budget counts them. |
| `QCLOUD_DATABASE_POOLER` | `none` or `transaction` | Whether a transaction pooler is in between. |
| `QCLOUD_DATABASE_TLS_CA_FILE` / `QCLOUD_DATABASE_TLS` | `/etc/qcloud/db-ca/ca.pem` / `unverified` or `off` | How the certificate is checked. The two are exclusive (and so is `QCLOUD_DATABASE_TLS_CA`, the PEM inline, used on AWS). |
| `QCLOUD_NAMESPACE` | the data plane's | The tenant of every row. |
| `QCLOUD_TRANSPORT`, `QCLOUD_GCP_PROJECT` | `gcp-pubsub`, the project | The doorbell the API rings when it adds, retries or promotes a job. |
| `QCLOUD_WEBHOOK_KEY` | secret reference, when `webhook_key_secret` is given | The key webhook signing secrets are sealed with (the data plane's `webhooks = true` makes it). Without it a webhook cannot be given a secret (409). |
| `QCLOUD_GCP_HOT_QUEUES` | `hot_topic_names` keys, when any | Queues with their own topic. Set only when a queue has `hot = true`. |
| `QCLOUD_API_OIDC_ISSUER`, `_AUDIENCE`, `_JWKS_URL` | `oidc_issuer`, `oidc_audience` (comma separated), `oidc_jwks_url` | What a token must satisfy. All three are required in production. |
| `QCLOUD_API_ROLE_CLAIM`, `_OPERATOR_ROLES`, `_VIEWER_ROLES` | optional | Where roles are and which values mean what. |
| `QCLOUD_API_CORS_ORIGINS` | the panel's URL and `extra_cors_origins` | Exact origins. A wildcard is refused at start. |
| `QCLOUD_API_EVENTS_HEARTBEAT_MS` | 15000 | Keep-alive comment on a stream. 15000 to 60000. |
| `QCLOUD_API_EVENTS_MAX_LIFETIME_MS` | 600000 | The API closes a stream after this long; the client resumes. |
| `QCLOUD_API_EVENTS_MAX_STREAMS` | `api_event_streams` (50) | Streams per instance; the rest of the concurrency is for ordinary requests. |
| `QCLOUD_FLEET_*` | from `fleet` | The workers' size, so the deployment page can check the connection budget. Optional. |
| `QCLOUD_VERSION`, `QCLOUD_COMMIT` | image build args | Shown on `/deployment` and `/health`. |
| `QCLOUD_API_HOST`, `QCLOUD_API_PORT` | `0.0.0.0` (image), 8080 | Where it listens. |
| `NODE_ENV` | `production` (image) | Production mode: the development token is refused. |

Not set in production, and refused where it would matter: `QCLOUD_API_DEV_TOKEN` (a static token for local
development; the process will not start with it beyond loopback unless `QCLOUD_API_DEV_TOKEN_ALLOW_NETWORK=true`, and in
production mode never). The rest (`QCLOUD_API_MAX_BODY_BYTES`, `_REQUEST_TIMEOUT_MS`, `_RATE_LIMIT_*`,
`_TICK_LATE_AFTER_MS`, `_TICK_STALE_AFTER_MS`, `_DEPLOYMENT_CACHE_MS`, `_SHUTDOWN_GRACE_MS`, ...) have defaults; they are
read in `packages/control-api/src/env.ts`, which is the one place that names them.

**Start refuses an unsafe combination** before it connects: no sign-in configured, a development token in production or
beyond loopback, a wildcard origin, a plain `http` JWKS URL in production, a heartbeat or lifetime out of range. The message names the variable and never its value; exit code 2.

### Panel (`server.js`)

| Variable | Set to | Meaning |
| --- | --- | --- |
| `QCLOUD_PANEL_API_BASE_URL` | the API's URL | Required. Becomes `/config.json` and the CSP's `connect-src`. |
| `QCLOUD_PANEL_AUTH_MODE` | `oidc` | `oidc` or `token` (a pasted token, for development). |
| `QCLOUD_PANEL_OIDC_AUTHORITY`, `_CLIENT_ID`, `_SCOPE`, `_AUDIENCE` | `oidc_authority`, `oidc_client_id`, optional | The sign-in. The authority is where `/.well-known/openid-configuration` is. |
| `QCLOUD_PANEL_CSP_CONNECT_EXTRA` | `panel_csp_connect_extra` | Further origins the page may connect to. The AI assistant in the panel calls a provider directly: its origin goes here, or the browser blocks it. |
| `QCLOUD_PANEL_BASE_PATH` | `/` | Where the panel is mounted. |
| `QCLOUD_PANEL_HOST`, `QCLOUD_PANEL_PORT`, `QCLOUD_PANEL_DIST` | image defaults | |

### Migration job and tick

| Variable | Meaning |
| --- | --- |
| `qcloud-api migrate`: `QCLOUD_DATABASE_URL` (the **direct** URL when a pooler exists, from `database_direct_url_secret`), `QCLOUD_DATABASE_POOL_SIZE=1`, the TLS pair, `QCLOUD_DATABASE_POOLER` | Brings the schema to this build's version and exits 0; 1 if it could not (the failed step rolled back whole); 2 for configuration. |
| tick: `QCLOUD_TICK_AUDIENCE`, `QCLOUD_TICK_ALLOWED_EMAILS` | Set by the data plane: the scheduler's token is the only one it accepts. `QCLOUD_TICK_SHARED_SECRET` is for development only. |
| tick: `QCLOUD_TICK_*` timings | See `docs/limits.md`. |

## Timeouts and event streams

The panel's live pages hold a server-sent event stream. From the outside in:

| Layer | Value | Why |
| --- | --- | --- |
| Cloud Run request timeout (API) | 900 s (`api_request_timeout_seconds`; 3600 at most) | Must outlast a stream by a margin. Plan refuses less than the lifetime plus 60 s. |
| Stream lifetime | 600 s (`event_stream_lifetime_seconds`; at least 600) | The API closes the stream cleanly; the browser reconnects with `Last-Event-ID` and loses nothing. |
| Server idle timeout | 255 s | The most Bun allows. The heartbeat keeps a stream under it. |
| Heartbeat | 15 s | A comment line. Nothing in front may time out an idle connection sooner than this. |
| Concurrency | 100 per instance, of which 50 are streams | A stream holds a request slot for its whole life. The plan refuses `api_event_streams >= api_concurrency`. |
| Minimum instances | 1 (decision D1) | The first request is not a cold start; the cost is small. |

Behind a proxy of your own (`private` mode with a load balancer), set its idle and request timeouts above 600 s, or the
stream is cut every time; the client reconnects, but the page flickers.

## Deploying

Order matters because the control plane reads what the data plane made.

1. **Data plane first** (once). `terraform -chdir=infra/gcp/example apply`. Set `tick_image` to the API image and
   `tick_command = ["bun", "/app/packages/maintenance/src/bin.ts"]`. Control plane capacity: `control_processes` must
   count the tick plus every API instance at `api_max_instances`; the control plane's plan refuses otherwise. For webhooks set
   `webhooks = true` (it makes the key), `tick_loop = {}` for a delay of a second and `webhook_sender = {}` for the sender;
   the loop and the sender are worker pools of the tick image, and each holds a pool of connections the budget counts. The
   key is in the Terraform state: back it up, because a lost key leaves every stored webhook secret unreadable.
2. **Build and push the images**, by digest:

   ```bash
   docker build -f packages/control-api/Dockerfile -t REGION-docker.pkg.dev/PROJECT/qcloud/api:$(git rev-parse --short HEAD) \
     --build-arg COMMIT=$(git rev-parse HEAD) --build-arg VERSION=1.0.0 .
   docker build -f packages/panel/Dockerfile -t REGION-docker.pkg.dev/PROJECT/qcloud/panel:$(git rev-parse --short HEAD) \
     --build-arg COMMIT=$(git rev-parse HEAD) .
   docker push ...    # then use IMAGE@sha256:<digest> in the variables
   ```

   Both images run as the `bun` user (uid 1000), have no dev dependencies, no shell scripts and no secret, and take the
   base image by digest. For an SBOM and provenance attestations, build with
   `docker buildx build --sbom=true --provenance=mode=max --push ...`. Moving the Bun version is deliberate: change
   `.bun-version`, the digest in both Dockerfiles, and rebuild.

   The **worker image** is the application's, and there is no Dockerfile for it here. A worker pool needs no listener and
   no `$PORT`; it needs the `QCLOUD_*` variables read and the SDK's `Worker` started, and it should finish a job or hand it
   back inside Cloud Run's fixed 10 s after `SIGTERM` ([limits](../limits.md#6-delivery-guarantees)). A sketch, **not built
   or run here**:

   ```dockerfile
   FROM oven/bun:1.4.2-slim@sha256:<the digest in packages/control-api/Dockerfile>
   WORKDIR /app
   COPY package.json bun.lock ./
   RUN bun install --frozen-lockfile --production
   COPY . .
   USER bun
   CMD ["bun", "src/worker.ts"]
   ```
3. **Hand the data plane's outputs over**:

   ```bash
   terraform -chdir=infra/gcp/example output -json control_plane_inputs > infra/gcp/control-plane/data-plane.auto.tfvars.json
   ```

   Then copy `ci.tfvars.example` to your own `*.tfvars` and set `api_image`, `panel_image`, the `oidc_*` values and
   `deployer_members`. `*.tfvars` and the handoff file are not committed.
4. **Plan, then apply the control plane.** `terraform -chdir=infra/gcp/control-plane plan` and read it: the two services,
   the job, three service accounts, bindings on resources (and one custom role with a single permission,
   `monitoring.timeSeries.list`, which is the only project-level grant: set `monitoring_read = false` to leave it out and
   the Job delivery page shows depth and age as unavailable). The first apply of services may fail on an unreadable image:
   push the images first.
5. **Run the migration job** before traffic moves to a build that needs a new schema:

   ```bash
   gcloud run jobs execute <name>-migrate --region REGION --wait
   ```

   Re-running it is a no-op (exit 0). The services never migrate on start. A service started before the job ran answers
   `/health` 200 and `/health/ready` 503 with `checks.schema.state = "behind"` and the text "run the migrations"; it
   becomes ready by itself once the job finishes, without a restart.
6. **Register the redirect URIs** (`terraform output oidc_redirect_uris`) at the identity provider, then open the panel.
7. **Smoke test** ([below](#smoke-test)).

Rolling a new release: build and push, set the two image variables, apply, run the migration job first when the release
carries a migration. Cloud Run sends traffic to the new revision only after its startup probe (`/health`) passes, and the previous
revision keeps serving until then.

## Smoke test

```bash
# On this machine, no cloud, no container: the same entrypoints over a local Postgres.
QCLOUD_TEST_DATABASE_URL=postgres://... bun run scripts/smoke-gcp.ts --local

# A deployed environment. The token is an OIDC access token of a test principal with the operator role.
QCLOUD_SMOKE_TOKEN=... bun run scripts/smoke-gcp.ts \
  --api-url "$(terraform -chdir=infra/gcp/control-plane output -raw api_url)" \
  --panel-url "$(terraform -chdir=infra/gcp/control-plane output -raw panel_url)" \
  --queue qcloud-smoke --scheduler-job <name>-tick --region REGION --project PROJECT
```

It checks, in order: `/health` public; every other route 401 without a token and with a malformed one; readiness with
the schema `current`; the panel's `/health`, `/config.json` and CSP; opens the event stream, adds a job, waits for
`job:completed`, reads the job back; triggers the tick and waits until `/deployment` records it; and that `/deployment`
reports a current schema, a database `ok`, no development token and no secret. `--local` adds the migration and rollback
drills. The queue needs a worker that completes jobs; the script never prints the token. The deployed run triggers the
tick with `gcloud scheduler jobs run` (a write to the project) only when `--scheduler-job` is given, otherwise it waits
for the scheduler's next minute.

## Rolling back

**The application.** Migrations are forward-only and safe with the previous release connected, so rolling back is
serving the previous revision against the migrated database:

```bash
# Services: send traffic to the previous revision (or apply the old image variables, which does the same).
gcloud run services update-traffic <name>-api --region REGION --to-revisions <previous-revision>=100
gcloud run services update-traffic <name>-panel --region REGION --to-revisions <previous-revision>=100
```

The older build reports the schema as `ahead` on `/deployment` and stays ready and serving. **Do not run the older
build's migration job**: it refuses a schema newer than it knows (`schema_ahead`, exit 1) and changes nothing. A bad
migration is fixed forward with the next version, never by editing a shipped one (its checksum is recorded and an
edited one stops every process with `SchemaDriftError`).

**What a rollback does not undo.** A column or table the release added stays; the previous release ignores it. A
release that was two-step (stop using a column, then remove it) is rolled back one step at a time.

`bun run scripts/smoke-gcp.ts --local` exercises this: an unmigrated start (`/health` 200, ready 503 `behind`), the
migration, then a schema one version ahead of the build (`ahead`: ready, still takes jobs, its own `migrate` refuses
with exit 1). That is the same entrypoint in local processes, not containers.

## Rotating the database secret

The URL holds the database password. The password is a Terraform `random_password` in the data plane, and each value of
a secret is a new numbered version that the services pin, so a rotation rolls new revisions:

1. Data plane: `terraform apply -replace=module.database.random_password.database`. The database user's password and a
   new secret version change together.
2. The data plane's apply also rolls the workers and the tick onto the new version. Existing connections stay open;
   reconnecting with the old password fails until the new revision serves, which is minutes. The SDK retries with
   backoff, and the tick repairs what the gap left.
3. Control plane: re-export `control_plane_inputs` (step 3 above) and apply. The new `database_url_secret.version`
   rolls the API; the migration job reads the new version on its next run.
4. Disable the old secret version: `gcloud secrets versions disable <n> --secret=<name>-database-url`.

Treat this as unproven until it has run against a real project (D9). If you use a pooler, its own credentials rotate
separately.

## Tearing down

The control plane has nothing stateful: `terraform -chdir=infra/gcp/control-plane destroy` removes the services, the job,
the service accounts and bindings. (The two services and the job are created with `deletion_protection = false`, so
destroy is not blocked.) The data plane's teardown steps and protections are in
[infra/gcp/README.md](../../infra/gcp/README.md#teardown). Destroy the control plane first.

## Checks without a cloud

```bash
bun run check:terraform          # fmt, init -backend=false, validate, a credential-less plan of both roots, assertions
bun run scripts/smoke-gcp.ts --local
docker build -f packages/control-api/Dockerfile -t qcloud-api:test .
docker build -f packages/panel/Dockerfile -t qcloud-panel:test .
```

The plan check drops every `GOOGLE_*` and `CLOUDSDK_*` variable and gives the provider a placeholder token, so real
credentials are never used. It asserts, among others: the only `run.invoker` binding is `allUsers` on the API and the
panel (the application enforces tokens; the scheduler's binding on the tick stays in the data plane), no secret and no
development token in any environment, request timeouts above the stream lifetime, the connection budget against the data
plane's, the handoff names against the fixture's values, and 13 refusals. The data plane's plan also asserts that the loop and the sender run the tick image as the tick's account, and that no worker account can read the webhook key.

## What has never run

- **`terraform apply`** (D9). Nothing here has created a resource. Terraform was validated and planned without
  credentials only.
- **The Docker images were not built** in the task that wrote them; the Dockerfiles are checked by reading and by running
  the same entrypoints, from the same file layout, as local processes. Build them before the first apply
  ([Checks](#checks-without-a-cloud)); the SBOM command is documented, not run.
- **Cloud Run behaviour**: that a stream survives to its 600 s lifetime through Google's front end, that Direct VPC
  egress reaches the database, that the secret mount and CA path work, that the computed URLs equal the service URLs (the
  plan has `check` blocks that say so on the next plan), and that `allUsers` is allowed by the organisation.
- **Worker pools**: nothing has created or scaled a `google_cloud_run_v2_worker_pool`, and the optional CREMA autoscaler
  has not run. A pool has no hard instance ceiling ([Scaling the workers](../../infra/gcp/README.md#scaling-the-workers)).
- **Identity provider**: no provider was configured; the tests sign tokens with a throwaway ES256 key.
- **Pub/Sub**: the dead-letter peek and the DLQ age metric were not run against the emulator or a real topic.
- **Rotation** and **IAP** are described, not exercised.
