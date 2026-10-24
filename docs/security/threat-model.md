# Threat model

Written for task 72 by the author of the code, so it holds the author's picture of the system. Read it with
[the v1.0.0 review](review-v1.0.0.md), which says what was checked against it and what was not.

## What is being protected

| Asset | Where it lives | Why it matters |
| --- | --- | --- |
| **Job payloads and results** | `qcloud_jobs` (msgpack, at most 1 MiB each) | Whatever the application put in them: personal data, internal ids, tokens it should not have put there. The Control API and the panel show them to a `viewer`. |
| **The database credential** | The cloud secret manager; the process environment at run time | Postgres is the only state. Whoever holds it can read, change and delete every job in every namespace. |
| **The database itself** | Cloud SQL / RDS, private network only | Integrity of job state: a changed row changes what runs. |
| **API credentials** | The OIDC provider's keys (verified), the development token (local only), the tick's service-account identity | They decide who may pause a queue, retry a job or register a webhook. |
| **Webhook signing secrets** | `qcloud_webhooks`, sealed with `QCLOUD_WEBHOOK_KEY`; shown once, when set | A leaked secret lets a third party forge events to a receiver. |
| **Availability of the tick** | One scheduled process | Without it nothing is repaired, so a lost bell stays lost ([the tick has stopped](../runbooks/tick-stopped.md)). |
| **The cloud bill** | The brokers, the database and the compute | A flood of jobs or bells costs money. |

The brokers hold **bells**, which carry no payload and no job id, so reading one gives an attacker nothing.

## Who acts

| Actor | Trust | Can |
| --- | --- | --- |
| **Viewer** | Trusted to read | Every read the Control API serves, including payloads and results. |
| **Operator** | Trusted to change | Everything a viewer can, plus every write: add, retry, remove, pause, clean, register webhooks. Every write is audited. |
| **A worker** (application code) | Trusted with its queues' data | Runs handler code with the database credential. A compromised worker has the credential, so it is a compromised database. |
| **The tick** | Trusted | Writes state, rings bells, sends webhooks. Invoked by the scheduler with a service-account identity. |
| **An external attacker** | None | Reaches whatever the deployment exposes: the Control API and panel URLs in `public` exposure and, when the ingest is deployed, its `/s/<token>` URLs, nothing else. |
| **A webhook target** | None | Receives signed events and answers, or does not. It may be hostile, slow, or an internal address the operator did not mean. |
| **A neighbouring tenant** (another namespace on the same database) | Same credential, so effectively trusted | See "Namespaces" below. |

## Trust boundaries

1. **Browser to Control API.** Bearer token, verified as an OIDC JWT (asymmetric algorithms only, issuer, audience, `exp`, `nbf`)
   or, outside production, the development token. The panel is static; the token lives in memory in the browser.
2. **Control API to database.** A password over TLS on a private address. The API is the only component that translates a
   caller's role into allowed statements; the database does not know about roles.
3. **Workers and tick to database and brokers.** One credential per process family, delivered by the secret manager. Broker
   access is per-resource (publish on the topic, subscribe on the subscription; send, receive on the queue).
4. **Scheduler to tick.** The tick endpoint accepts a Google-style OIDC identity token (RS256) for one configured audience and an
   allow-list of service-account emails, or, for development, a shared secret of at least 24 characters. It is not a public endpoint.
5. **Tick to webhook target.** Outbound HTTPS to an address the operator registered. The sender resolves the name itself,
   refuses non-public addresses, pins the connection to the resolved address and does not follow redirects (`qcloud-tick send` may keep a connection or a name's addresses for a short time, and still checks every address on every use). Only the status line of the answer is read (at most 16 KiB), within a 10 s bound.
6. **Internet to the ingest** (opt-in). Anyone may post to `/s/<token>`; the token is the address, and a source can add a signature, a key or a password. The ingest validates, stores and answers, and holds no outbound network, no queue permission and no job state. It is the one component an unauthenticated stranger reaches by design, and it has had a self-review only ([known issues](../known-issues.md), row 12).
7. **Operator to cloud.** Terraform and the cloud console. Out of this system's control; the repo only decides what it asks for.

## Abuse cases

| # | Abuse | Defence | Held by |
| --- | --- | --- | --- |
| A1 | Call an API route with no token, a bad token, an `alg: none` or HMAC-signed token, an expired or not-yet-valid token, the wrong audience or issuer | 401 on every route but `GET /health`; asymmetric algorithms only; `exp` required | [`routes.md`](routes.md), `security.routes.test.ts`, `auth.test.ts` |
| A2 | A viewer performs a write or reads an operator-only route | The route table says which; 403 `forbidden` | `security.routes.test.ts` |
| A3 | Run the development token in production | Startup fails when `NODE_ENV=production`; `production: false` cannot override it | `config.test.ts` |
| A4 | Call the tick endpoint without being the scheduler | Identity audience and e-mail allow-list; constant-time comparison for the static form | `packages/maintenance/test/auth.test.ts` |
| A5 | Send an oversized or hostile body | 413 before the handler, 415 for non-JSON, 400 for bad UTF-8, 1 MiB cap on the encoded payload and on a result | `security.pass.test.ts`, [limits](../limits.md) |
| A6 | Inject SQL through a queue name, a job name or a filter | Values are parameters; the few dynamic identifiers are constants or the schema name, passed as a startup parameter | [review, input handling](review-v1.0.0.md#input-handling) |
| A7 | Plant a payload that harms the decoder (prototype pollution, extension types, a huge declared length) | `__proto__` survives as an own key; only the known extensions decode; declared lengths past the data fail at once. **Bounded per payload (20,000 values, 64 levels) but not per list page (F-2, narrowed)** | [review, input handling and F-2](review-v1.0.0.md#findings) |
| A8 | Point a webhook at an internal address, a metadata service, or a name that resolves to one later (DNS rebinding), or redirect to one | Public addresses only, checked at connect time on the pinned address; no redirects; only the status line is read, 10 s for the exchange | [webhooks](../webhooks.md), [review, webhooks](review-v1.0.0.md#webhooks) |
| A9 | Steal a webhook secret from the API or the logs | Sealed at rest, never returned by the API (the one exception: a secret the service generated is in the create or rotate response, once); a rotated-out secret is dropped after 24 hours; no secret, token, payload or connection string in any log line | `test/observability/logs.test.ts`, `security.pass.test.ts` |
| A10 | Exhaust the API with streams, long lists or write floods | Per-principal and per-instance SSE caps, page-size caps, write rate limit | `security.pass.test.ts`, `events.limits.test.ts` |
| A11 | Read another tenant's jobs | Every query carries the namespace | Many suites; see the review. **Not a hard boundary.** |
| A12 | Reach the database from the internet | Private IP only (Cloud SQL), `publicly_accessible = false` (RDS); TLS only | `check:terraform` |
| A13 | Lose the database through a mistaken `terraform destroy` | `prevent_destroy` and deletion protection on, backups and point-in-time recovery on | `check:terraform`, [restore runbook](../runbooks/restore-from-backup.md) |
| A14 | A worker with a stolen credential | Out of scope for this system: the credential is the database. Rotate it ([runbook](../runbooks/rotate-database-secret.md)) | game day, local only |
| A15 | Save a webhook filter or shape that runs code, reads data it was not given, or makes a huge body | A filter and a shape are JSON data evaluated by two fixed functions in core: no code, no network, and the only input is the request document `{ method, headers, query, body }`, read by paths that walk own properties and never `__proto__`, `constructor` or `prototype`; the stored credential headers are `[redacted]`, so a rule cannot read them. Bounded in terms, depth, text and template size; a body past 64 KiB is not sent; the stored body is what is signed | `webhookFilter.test.ts`, `webhookShape.test.ts`, `webhookPath.test.ts`, `inbound.rules.test.ts`, `webhooks.test.ts` |
| A16 | A hostile receiver uses the delivery history to read an internal service, or to plant text for whoever reads it | Only a public address is connected to, so the answer is a public receiver's own words; with private addresses allowed (dev mode) nothing is kept unless asked. At most 1 KB (4 KB cap) of a failed answer, as text with control characters removed, NUL stripped, an encoded body not kept; it is data in a JSON field and the panel shows it as text | `webhook.capture.test.ts`, `webhook.record.test.ts` |
| A17 | Post to a source without being its sender: guess a token, replay a captured post, forge a signature | A token is `qin_` plus 256 random bits, stored only as its SHA-256; an unknown, a disabled and a removed token answer alike. A verifying source compares a digest of the signature, key or password in constant time, and accepts the previous secret only for 24 hours after a rotation. **A signed request carries no timestamp, so a captured one can be posted again** (a dedupe key on the route is the defence; [known issues](../known-issues.md), row 12) | `packages/ingest/test/handler.test.ts`, `verify.test.ts`, `ingest.db.test.ts` |
| A18 | Flood the public ingest: many posts, huge or slow bodies, random tokens | Body cap 256 KB held three ways, a deadline on the body, a rate per source and a global rate (per process), rejections stored without a body and at most 60 a minute per source. **A flood of random tokens uses the global rate and refuses real senders until the minute ends**; the per-address limit is the edge's (Cloud Armor, the WAF) | `scripts/ingest-load.ts`, [limits, section 15](../limits.md#15-the-public-ingest-tasks-07-to-10) |
| A19 | Read a source's token, secret or a post's credentials from the stored request, a log or the API | The ingest logs no path, header or body; `authorization`, `cookie`, `proxy-authorization`, `set-cookie` and the source's own verification header are stored as `[redacted]`; a secret is sealed with the webhook key; a token and a secret are in no read, only in the response that made them. **The token is in the URL, so a load balancer or Cloud Run request log holds it**, and a viewer reads headers and query (not the body) | `ingest.db.test.ts`, [observability](../observability.md#logs) |
| A20 | Use the ingest to reach an internal service | It calls nothing: it stores a request and answers. The tick sends, behind the checks of A8. The ingest needs no outbound network | `bun run architecture` (no transport, no sender), `check:terraform` |

## What this model does not claim

- **A worker's code is not sandboxed.** Handlers run with the database credential; an application that runs untrusted code in a
  handler must isolate it itself.
- **Payloads are not encrypted by this system** beyond the database's encryption at rest and TLS in transit. An application that
  needs the operators not to see a field must encrypt it before it enqueues.
- **Namespaces are not a tenant boundary** (below).
- **`public` exposure puts the application's token check alone in front of the internet.** No web application firewall and no
  edge rate limit is deployed unless you set the opt-in `edge` (GCP, Cloud Armor) or `edge_rate_limit_per_minute` (AWS, WAF);
  the API's own limits are per process.

## Namespaces

A namespace scopes every row and every cloud queue name, and every store query filters on it. That keeps two environments
(`staging`, `production`) from seeing each other's jobs by mistake, and many suites hold that (the review lists them). It is
**not** a hard multi-tenant boundary: two namespaces on one database share one credential, one set of tables, one set of
connections and one cloud project, so one tenant's code, or one bug in a query that forgot its filter, reaches the other's
rows, and one tenant's load slows the other. Give tenants that must not see each other their own database and cloud project.
