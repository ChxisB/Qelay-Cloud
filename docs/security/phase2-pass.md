# Security pass of the control plane (task 37, 2026-10-15)

**Who did this: the author of the code.** That is a weaker check than an independent review. It finds what the author
thought to ask and misses what they did not, and it shares their blind spots about the design. It is the Phase 2 gate's
pass, not the release review: task 72 writes the threat model and
`docs/security/review-v1.0.0.md`, and you decide there whether an outsider reviews before anything is published.

Scope: the Control API (`packages/control-api`), the panel's static server (`packages/panel/serve`), their images and the
dependency tree. Not covered: the tick endpoint's network exposure on a real project, the transports against a real
broker, IAM as applied, and anything in a deployed environment (decision D9: nothing was applied).

## Method

One sweep test walks every operation `docs/openapi.yaml` documents, so a route added later is held to the same rules
without anyone remembering to ask: `packages/control-api/test/security.pass.test.ts`. The narrower cases already had
their own files; each row below names the test that holds the property.

## Results

| Item | Result | Held by |
| --- | --- | --- |
| **Authentication bypass** | Every documented operation but `GET /health` answers 401 with no credential and with a malformed one, and a bad credential is never echoed. Encoded, doubled and traversal paths (`/%2e%2e/audit`, `/queues//jobs`, `/AUDIT`, `/audit%00`) are 401 unauthenticated and never 200 for a viewer. | `security.pass.test.ts` (sweep), `auth.test.ts`, `auth.access.test.ts` |
| **Role enforcement** | A viewer is refused every change with 403 `forbidden`, on every documented mutation, and refused exactly two reads (`GET /audit`, `GET /transport/dead-letters`), pinned by name so a new refusal or a new gap fails the test. Non-GET `/server/*` style operations are operator-only. | `security.pass.test.ts`, `audit.test.ts` (a refused attempt is recorded under the viewer's role) |
| **CORS** | A listed origin gets its own origin echoed with `Vary` and never credentials or a wildcard; any other origin gets no CORS header; a preflight from an unlisted origin is 403; with none configured no header is sent. | `pipeline.edge.test.ts`, `server.test.ts` |
| **Request size caps** | A body over the cap is 413 before the handler runs, a streamed body with no length is cut off at the cap, a non-JSON body is 415, invalid UTF-8 is 400, and the answer to a bad body does not echo the value. | `pipeline.test.ts` |
| **SSE caps** | A principal over its stream cap is 429 with `Retry-After` and closing one makes room; an instance with no room is 503; a stream ends at its maximum lifetime; a client that does not read is dropped and the journal is not read ahead of it; a client that goes away gives its place back. | `events.limits.test.ts` |
| **Audit coverage** | Every documented mutation writes exactly one closed entry whatever it answers; a refusal is an entry with its reason; a change that cannot be recorded is not made; an entry holds identifiers only (no payload, no query string, no credential). | `audit.test.ts` |
| **No secrets in responses or logs** | The development credential is in no response body, no header and no request, error or warning log record across the sweep; `/deployment` holds no token, connection string or password; configuration errors name the variable and never repeat the value. | `security.pass.test.ts`, `ops.deployment.access.test.ts`, `runtime.main.test.ts` |
| **Response headers** | Every answer, for either role, is `X-Content-Type-Options: nosniff` and `Cache-Control: no-store` and carries a request id. | `security.pass.test.ts` |
| **Panel server** | Hashed assets immutable, the policy hashes the one inline script, no `unsafe-eval`, `frame-ancestors 'none'`, only GET and HEAD, `/config.json` carries public settings only, the credential is held in memory (not storage, address or console). | `packages/panel/test/serve.test.ts`, `e2e/control-api.e2e.ts` |
| **Dependency audit** | `bun audit` found two advisories on `tinypool@2.1.0` (prototype pollution leading to code execution through worker options), reached only through `oxfmt`, the formatter, which is a development dependency and is not in any image. **Fixed** with an `overrides` entry (`tinypool` 2.1.2) and the lockfile; `bun audit` now reports no vulnerabilities across 282 packages. | `bun audit` |
| **Container scan** | **Not run.** No image has been built (the Docker runs are deferred to the end of the plan, by your instruction). Owed: build both images, scan them, and generate the SBOM (`docker buildx build --sbom=true --provenance=mode=max`). | n/a |

## Findings

| # | Severity | Finding | Status |
| --- | --- | --- | --- |
| S1 | Low (dev tooling only) | `tinypool` advisories through `oxfmt` | Fixed (override, lockfile) |
| S2 | Medium, unverified | Panel `style-src 'unsafe-inline'` (the build's inline styles); AI-provider `connect-src` needs `QCLOUD_PANEL_CSP_CONNECT_EXTRA`, so an operator who adds one widens the policy | Accepted for 1.0, recorded in the runbook; owner task 72 |
| S3 | Low | Audit rows are not written for a 401 or an unknown route (an unauthenticated probe is in the request log, not the audit table) | Accepted: the audit table is for accepted and refused changes by a known principal; owner task 72 |
| S4 | Low | An audit prune failure is swallowed (logged, not raised) | Accepted; owner task 71 (observability) |
| S5 | Low | A client that never reads is held until the stream's maximum lifetime, not dropped sooner | Accepted; bounded by the per-principal cap; owner task 72 |
| S6 | Info | `/health/ready` needs a token, so Cloud Run probes use `/health` (public, says nothing) | By design; documented in the runbook |
| S7 | Unknown | The container image has never been scanned; the base image digest is pinned in both Dockerfiles | Open, owed with the Docker runs; **must be closed before task 73** |

**No finding of high or critical severity is open.** S7 is open because it was not run, not because it was found
clean: a scan could produce findings, and that is the honest state of the claim.

## What this pass did not do

- An independent reviewer's pass, or a penetration test of a deployed environment.
- Dependency licensing, provenance of ported code, or secret scanning of history (the repository has no commits).
- Rate limiting across instances: the limiter is per instance, so N instances allow N times the rate. Documented,
  not changed.
- The OIDC issuer's own configuration (token lifetime, audience, revocation), which belongs to whoever runs the issuer.
