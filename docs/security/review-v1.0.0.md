# Security review for v1.0.0

**This is a self-review.** It was done by the author of the code, in one session, with the tools the repository already has. It finds
what the author thought to ask and misses what they did not, and it shares their blind spots about the design. It is not a
penetration test and does not replace one. **Have someone independent test the system before it holds sensitive data in
production.** Two parts in particular want an outside reader: the webhook sender's SSRF defences and what the panel shows to a
`viewer`.

Date: 2026-10-17. Scope: the whole repository as of this task: the Control API, the panel's static server, the maintenance tick and
webhook sender, the store, the SDK, both transports, the Dockerfiles and the Terraform. The model it checks against is
[threat-model.md](threat-model.md). The earlier, narrower [phase 2 pass](phase2-pass.md) (task 37) is kept; this review builds on
its tests rather than repeating them.

**Nothing was run against a real cloud** (decision D9): every infrastructure statement below comes from reading the Terraform and
from `check:terraform`, which plans without credentials. Container images were **not built or scanned** (Docker is deferred to the
end of the plan).

## Findings

Severity is the author's judgement, and where it is uncertain it is set higher, not lower. **No finding is rated high or critical.**
One medium finding (F-2) is **narrowed and still needs your decision.**

| # | Finding | Severity | Status |
| --- | --- | --- | --- |
| F-1 | Two operator-only reads (`GET /audit`, `GET /transport/dead-letters`) were enforced by a check inside each handler, not declared with the route. A new read route could skip the check without anything failing. No bypass was found. | Low | **Fixed.** `operatorOnly` is a property of the route, enforced once in `app.ts`, and the generated [route table](routes.md) is held row by row by a test. |
| F-2 | **Decode amplification.** The 1 MiB payload cap is on encoded bytes. One million `null`s is 1 MiB and decodes to about 19 MB. `GET /queues/:queue/jobs/list` decodes every payload of a page before cutting each to 1,024 bytes: 20 such jobs grew the API process by **357 MB** in 300 ms (measured against Postgres 18), and a page may hold 500. A producer that relays untrusted JSON into a payload can make a list call exhaust the API's memory, and it repeats while the job exists. Workers are not affected (one payload at a time, about 19 MB). | **Medium** (availability of the control plane, not confidentiality or integrity) | **Narrowed after the review (option (a) with 20,000 values and 64 levels, not 250,000; it walks the value, not the encoded bytes). Still needs the user's decision on the number and on (b).** Documented in [limits](../limits.md) section 13 with the mitigation available today (`QCLOUD_API_MAX_PAGE_SIZE`, task memory). A fix narrows what a payload may be, which is a change to the queue's contract, so it was not made here. Options: (a) cap decoded elements per payload at enqueue (a walk of the encoded bytes; the number is the decision, 250,000 would pass any realistic payload); (b) decode lazily, one job at a time, in the list route; (c) accept and keep the documentation. Recommended: (a) and (b) together. |
| F-3 | A webhook may point at any port of a public host, and the failure category (`refused`, `timeout`, `tls`, `bad_response`) is visible to an operator, so an operator can use the sender as a port-scan oracle against public hosts. Internal addresses stay refused. | Low | **Accepted.** Only an operator can register a webhook, and an operator can already see the audit trail of what they did. Restrict to 443 if you want it closed. |
| F-4 | Both control-plane Terraform roots default to `exposure = "public"`: Cloud Run with `allUsers` as invoker, or an internet-facing load balancer. The application's token check is then the only barrier, and no web application firewall or edge rate limit is deployed unless you set one (`edge` on GCP, `edge_rate_limit_per_minute` on AWS, both off by default, plan-checked and never applied). | Medium (posture) | **Accepted as the documented default.** `exposure = "private"` exists in both and is tested by `check:terraform`. Use it, or put identity-aware access in front, when payloads are sensitive. |
| F-5 | Container images were not built, scanned for vulnerabilities, or published with SBOMs. The Dockerfiles were read (below). | Not assessed | **Deferred to the Docker run at the end of the plan** (owner: you). Not closed, so the release in task 73 should not claim scanned images. |
| F-6 | Namespace isolation is not a hard boundary (one credential, shared tables). | Informational | **Accepted and documented** in [concepts](../concepts.md#namespaces-queues-and-the-panel) and the [threat model](threat-model.md#namespaces). |
| F-7 | The panel shows payloads, results and workflow inputs to every `viewer`. | Medium if payloads hold secrets | **Accepted and documented** ([limits](../limits.md) section 13). Reviewing what a panel should reveal is owed to the independent test. |
| F-8 | The secret scanner flagged four test fixtures (a webhook secret, the 64-hex webhook key, a canary string). They are fixtures, not credentials. | Informational | **Fixed:** an allow-list for those four values in [.gitleaks.toml](../../.gitleaks.toml). |

## Authentication and authorisation

- **Every route against its role.** [routes.md](routes.md) is generated from the routes the app serves (`bun run security:routes`;
  `--check` fails when it is stale): 105 routes, 1 public (`GET /health`), 46 for a viewer or an operator, 58 for an operator only.
  `packages/control-api/test/security.routes.test.ts` holds each row: no token or a bad token is 401 on every other route and the bad
  token is not echoed; a viewer is refused 403 `forbidden` on every operator row and let through on every other; an operator is
  refused on none. The event streams are skipped for the handler-reaching calls and covered by `events.test.ts` and
  `events.limits.test.ts`. The test also fails if a second route becomes public.
- **JWT edge cases** (`packages/control-api/test/auth.test.ts`): `alg: none` and symmetric algorithms refused; a bad signature; expired
  and not-yet-valid tokens (with the tolerance stated); a missing `exp` or `sub`; the wrong audience and the wrong issuer; an unknown
  `kid` (one refetch, no flood to the issuer); an unreachable key set (401, and the operator is told why); every refusal gives the
  same answer and no token is logged.
- **The development token cannot run in production** (`config.test.ts`): startup fails under `NODE_ENV=production`, and an explicit
  `production: false` does not override it. It is compared in constant time.
- **The tick endpoint** (`packages/maintenance/test/auth.test.ts`): an OIDC identity token for one audience and an allow-list of
  service-account emails, or a shared secret of at least 24 characters compared in constant time over digests.
- **Audit**: every write writes one entry, a refusal writes an entry with its reason, and a change that cannot be recorded is not
  made (phase 2 pass).
- **Namespaces.** Isolation is held by tests in many places (`ring.query`, `doorbell`, `lease.release`, `lease.heartbeat`,
  `deployment`, `clean`, `completions`, `journal.retention`, `groupRetention`, `webhook.trigger`, `webhook.registry` in the store, and
  `queues.boundaries` in the Control API: a job of another namespace is not found by id, by custom id or by an action). They show the
  filters work where they are tested. No single test walks every query, so **a query added later that forgets its filter is not
  caught by a test**. That is one more reason the boundary is not a hard one.

## Input handling

- **Size limits.** A request body is capped (413 before the handler, a streamed body with no length is cut off, 415 for non-JSON,
  400 for bad UTF-8). A job's encoded payload and its result are each at most 1 MiB, refused with `PayloadTooLargeError` and nothing
  written, at `add`, `addBulk`, edit and completion. A batch is at most 1,000 jobs. Lists are paged (500 by default at most, the store
  allows 1,000), flows return at most 5,000 jobs, event streams are capped per principal and per instance. All of this is in
  [limits](../limits.md). **The one gap is F-2:** a byte cap does not bound the memory a decode takes; a cap on values and nesting now does for one payload, not for a page.
- **SQL.** All values are parameters. There are 28 `.unsafe(` call sites in 14 files of `packages/*/src`; each was read. The text
  they build is constant, or interpolates only a constant fragment chosen in code (a column list, a sort direction from a closed
  set, a count of placeholders), and the schema name reaches the connection as a startup parameter (`search_path`), not through
  SQL text. No queue name, job name, id or user filter is ever put into SQL text.
- **Payload decoding (msgpack through `msgpackr`).** Probed with hostile bytes against the codec:
  - a declared length of about 4 billion for an array, map, string, binary or extension, with no data, fails at once (0 ms) with
    "Unexpected end of MessagePack data" or an equivalent, and allocates nothing;
  - one million nested arrays raise `RangeError` (stack), caught as an ordinary decode error;
  - an unknown extension type throws; a truncated payload throws; a pointer to an undefined record id throws;
  - a RegExp extension with an invalid pattern throws `SyntaxError` on decode; an Error extension with an unknown class name decodes
    to a plain `Error` carrying that name (no lookup of a constructor from the name), and the name `__proto__` is just a string;
  - a `__proto__` key survives as an own property and does not touch the prototype (the codec's own test);
  - **a flat array of tiny elements decodes to 19 times its size, and an array of empty arrays to 70: F-2** (now capped at 20,000 values a payload).
  A decoded RegExp from a payload is the application's to handle: a pattern of its choosing run against attacker text is a ReDoS
  risk in the application's handler, not in this system.
- **JSON in the API.** Bodies are parsed as JSON only, validated by schema, and payloads leave as the tagged encoding (`bigint`,
  `date`, `bytes`, `map`, `set`, `-0`, `undefined`) with a `truncated` marker over the byte budget. Errors do not echo the body.

## Webhooks

Self-review of the sender (task 52) against [webhooks](../webhooks.md#where-a-webhook-may-point):

- the name is resolved by the sender and every address must be public; loopback, private, link-local (the metadata addresses),
  carrier-grade NAT, multicast and the IPv6 equivalents, including IPv4-mapped forms, are refused; the connection is made to the
  resolved address, so a second lookup cannot rebind it (DNS rebinding);
- a redirect is a failed attempt and is never followed; only the status line of a success is read; a failed answer's first 1 KB (at most 4 KB) is kept as text in the
  attempt's history, and not at all when private addresses are allowed unless asked, within a 10 s bound for the whole exchange; a resolved
  address is never kept;
- a delivery records a failure category and nothing else; the URL a viewer sees is cut to its origin;
- the signature is `HMAC-SHA256(secret, timestamp + "." + body)` with a timestamp header, so a receiver can reject a replay; the
  secret is sealed at rest with `QCLOUD_WEBHOOK_KEY`, is returned once when set, is not in an audit row or a log line, and the key
  must be the same in the Control API and the tick;
- `qcloud-tick send` (R14) keeps connections and names, and neither weakens the checks: a kept connection is keyed by address,
  port, TLS name and CA, so one verified for a name is not used for another; a cached name keeps its addresses, never a verdict,
  so every address is checked on every use and a name that turns private is refused once its entry expires (at most
  `QCLOUD_WEBHOOK_DNS_TTL_MS`, 30 s by default, after the change; the connection to an address already checked is the same
  pin as before); a connection is kept only after a clean `HTTP/1.1` answer of known length, so a response cannot desynchronise
  the next request on it; the sender holds one entry per destination in memory, bounded by the webhooks of a namespace (100) and
  1,024 cached names;
- the tests are `packages/maintenance/test/webhook.*.test.ts` and `packages/core/src/webhookUrl.test.ts`, which include a rebinding
  resolver and a redirect.

Findings: F-3 only. **This is the part most worth an independent review**: address-class parsing and connection pinning are where
real-world SSRF bypasses live.

## Secrets

- A scan of the working tree with **gitleaks 8.30.1** (default rules, [.gitleaks.toml](../../.gitleaks.toml) allow-listing only the
  four fixture values and the dependency and build directories) reports **no leaks** (about 10.9 MB scanned). **The repository has
  no commits yet, so no history was scanned**; run `gitleaks git` on the first commit and before every release.
- No payload, result, token, password or connection string is in any log line the repository writes
  (`test/observability/logs.test.ts` scans every log call and sends a canary payload and secret through the API and the SDK), none
  in an API response (phase 2 pass), and a webhook secret is never returned after it is set (a generated one is returned once, in the response that made it).
- The database credential reaches the processes through the cloud secret manager only: Secret Manager with a per-secret
  `secretAccessor` grant on GCP, Secrets Manager with a per-secret read policy on AWS. The `.dockerignore` keeps `.env*`,
  `*.tfvars`, state and plans out of images.
- **Rotation** was exercised only in its local form, in the game day: a rotated password on a throwaway role, open connections stay,
  a process that logs in again fails until it has the new one, no job is lost. The provider's own secret-version steps were not run.

## Dependencies and containers

- `bun audit`: **no vulnerabilities found (289 packages)** on 2026-10-17. That reports advisories already published; it says nothing
  about a package that was malicious but is not yet flagged.
- Versions are pinned by `bun.lock`; the images install with `--frozen-lockfile --ignore-scripts`.
- **Dockerfiles, read not built:** the base image `oven/bun:1.4.2-slim` is pinned by digest; the process runs as the non-root `bun`
  user; application files are root-owned and read-only to it; the production install leaves out dev dependencies, tests and the
  panel; a health check is set; `.dockerignore` excludes `.git`, `.claude`, tests' output and anything credential-shaped. The build
  command in the Dockerfile asks for an SBOM and provenance attestations.
- **Not done (F-5): no image was built, no image was scanned, and no SBOM was produced or published.**

## Infrastructure

Read in `infra/gcp` and `infra/aws` (104 `.tf` files), and checked by `check:terraform` (plans without credentials; **never applied**):

- **Database not public:** Cloud SQL `ipv4_enabled = false` on a private IP with `ssl_mode = ENCRYPTED_ONLY`; RDS
  `publicly_accessible = false` in private subnets with `rds.force_ssl`; storage encrypted (RDS `storage_encrypted = true`, a
  customer-managed key optional; Cloud SQL encrypts by default).
- **Backups and deletion:** point-in-time recovery and retention on both; Cloud SQL `deletion_protection` and RDS
  `deletion_protection` plus `skip_final_snapshot = false`; `prevent_destroy` on both databases. The stateless Cloud Run services
  have `deletion_protection = false` on purpose.
- **Public endpoints only where intended:** the only `allUsers` grants are the two `run.invoker` bindings of the control plane's
  `exposure = "public"` (F-4); the only `0.0.0.0/0` are the NAT and internet-gateway routes, the tasks' HTTPS egress to the cloud's
  APIs (and the webhook targets), and the load balancer's ingress in `public` mode. A private deployment narrows both.
- **IAM is resource-scoped.** GCP: `pubsub.publisher` on the topic, `pubsub.subscriber` on each subscription, `secretAccessor` per
  secret, `run.invoker` on the tick service for the scheduler, `serviceAccountUser` on named accounts only, no project-level role
  but a custom role with the single permission `monitoring.timeSeries.list`, no service-account keys, no Cloud SQL role. AWS: queue
  policies deny send, receive and delete to every principal but the admitted roles and deny any non-TLS access; `iam:PassRole` is
  limited to the tick's two roles and to ECS; no IAM users or access keys, no managed administrator policies. The one wildcard
  action is the KMS key policy's account-root statement, which is the AWS default and delegates to IAM policies.
- **Not checked:** the policies as applied, organisation policies, the cloud console's own defaults, and anything that differs between a
  plan and a real account.

## What this review did not cover

- A penetration test of a running deployment, and fuzzing beyond the hostile-payload probes above.
- The panel's front end beyond phase 2's checks (policy, headers, credential held in memory), and cross-site scripting through a
  payload shown in the panel.
- Bun, PostgreSQL, PgBouncer, ElasticMQ and the cloud services themselves.
- Supply-chain attack on a dependency not yet reported, the licence of each dependency, and the integrity of the build machine.
- Container images (F-5), and the Terraform as applied.
- Denial-of-service at the network edge (no WAF is deployed; F-4), and cost abuse.
- Timing and side channels other than the constant-time token comparisons.

## To do before production use with sensitive data

1. Decide F-2's number and whether the list decodes lazily (see its row), then re-run the `limits` measurement.
2. Build the images, scan them, produce and publish the SBOMs (F-5).
3. Commission an independent test, starting with the webhook sender and the panel's exposure of payloads.
4. Run the real-cloud checks that D9 holds back: an alert firing, a restore, a secret rotation.
5. Choose `exposure = "private"` or put identity-aware access in front of a public control plane (F-4).
