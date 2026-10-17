# 30 — Control API: core, auth, capabilities, health

**Status:** done · **Depends on:** 15 · **Phase:** 2

## Goal

Create `packages/control-api`: the HTTP service the panel talks to. This task builds the skeleton the other endpoints hang on: server, routing, authentication, error shape, the `/capabilities` and `/health` endpoints, and the contract tests that pin the shapes the panel already expects.

## Scope

In: server, router, auth, request validation, error model, `/health`, `/capabilities`, `/stats`, contract-test harness, OpenAPI document.
Out: jobs/queues endpoints (31), DLQ/cron/workers/events (32), flows (51), workflows (62).

## Reference

Panel clients that define the shapes: `../qelay-control-panel/src/lib/bq/serverApi.ts`, `queueApi.ts`, `api.ts`, `docs/api-mapping.md`.
Keep the **paths and JSON shapes** the panel calls today; where Qelay's TCP server did something we do not, return a typed `501 not_supported` with a `capability` name, not a fake success.

## Steps

1. **Server:** `Bun.serve` with a small router (no framework unless task 06 chose one). Request body size cap, per-request timeout, structured request log with a request ID, no payload logging.
2. **Error model:** one JSON shape `{ error: { code, message, details? } }`; map `core` typed errors to status codes; never leak stack traces or SQL.
3. **Authentication (D4):** verify an OIDC JWT (issuer, audience and JWKS URL from config, clock-skew tolerance, JWKS cache with refresh on unknown `kid`); a dev-only static admin token that **refuses to start in production mode**; roles `viewer` and `operator` from a configurable claim. Mutating routes need `operator`.
4. **CORS and CSRF:** an explicit allow-list of panel origins; bearer tokens only, no cookies, so CSRF does not apply. Say so in the README.
5. **`GET /capabilities`:** returns `{ transport: { name, maxDeliverDelayMs, ordering }, features: { dlq, cron, flows, workflows, webhooks }, hidden: ['serverControl','sqliteDatabase','s3Backup','fleet'], version }`. The panel (task 34) uses this to hide pages.
6. **`GET /health` and `GET /health/ready`:** liveness is cheap; readiness checks the database and records the transport's reachability and the last successful tick (task 20). Neither returns data about jobs.
7. **`GET /stats` and `GET /dashboard` stubs** wired in task 31; define the response types here from the panel's clients.
8. **Contract tests:** fixtures captured from the panel's own types and fixtures; a test per endpoint asserting the response parses with the panel's zod/TS shapes (import the panel's type definitions after task 33, until then copy them into `test/contract/shapes/` with a comment of their source commit).
9. **OpenAPI:** generate or hand-write `docs/openapi.yaml` for what exists so far; extend per task.
10. **Rate limiting** per principal on mutating routes (a simple token bucket in memory is enough for v1.0.0; document that it is per-instance).

## Acceptance

- Unauthenticated requests to anything except `/health` get 401; a `viewer` token on a mutating route gets 403.
- The dev token cannot be enabled when `NODE_ENV=production` (startup fails with a clear error).
- `/capabilities` matches the declared transport and enabled features, and is covered by a test per transport.
- Error responses never contain a stack trace or SQL text (test with a forced failure).
- An expired JWT, a wrong audience, a wrong issuer and an unknown `kid` are all rejected (tests).

## Verify

```bash
bun run typecheck && bun run lint && bun run format:check && bun run architecture
bun test packages/control-api
```

## Risks / notes

- Auth is the highest-impact piece of this package. Prefer a small, audited JWT verification dependency over hand-rolling signature checks; record the choice.
- Do not widen CORS "to make it work". Fix the origin list.
- A request-size cap matters because payloads reach msgpack and Postgres; reject early.

## Result

**Done locally, with the Postgres-backed readiness probe on PostgreSQL 18.6 (not the Docker PG 16 of CI); no cloud touched.** The
whole suite also passes with the database and the Pub/Sub emulator up: 1,932 pass, 54 skip (the Docker-backed suites), 1 todo, 0 fail.

**Built** (`packages/control-api`, 1,714 lines of source in 21 files, every file under 300 lines)

- **Server and pipeline** (`src/app.ts`, `src/http/`, `src/server.ts`): `Bun.serve` over a hand-written router (literal segments beat
  `:param`; a duplicate method and shape throws at startup). Order: request ID, CORS preflight, route match, **authentication (before a
  404 or 405, so an unauthenticated caller learns nothing about which paths exist)**, 404/405, role, rate limit, declared body size,
  handler under a time limit. `app.handle(request)` never throws, so tests call it without a socket.
- **Error model** (`src/errors.ts`): `ApiError` and `toApiError`. Every message and detail is written in this package; a cause, a stack
  and SQL never reach a response (forced-failure tests, including a store error whose cause holds SQL and a thrown `Error` with a stack).
  Unknown failures are `internal_error` plus the request ID, and the log carries their type and code only.
- **Authentication** (`src/auth/`, `src/config.ts`): `jose` 6.2.12 (`createRemoteJWKSet` and `jwtVerify`, nothing else of it). RS256 and
  ES256 only, `none` and `HS*` refused at startup; issuer, audience (any of a list), `exp` and `sub` required, clock tolerance,
  `currentDate` from the injected clock, JWKS cache with a cooldown, and a refetch for an unknown `kid`. Roles from a configurable claim
  (string or array, dotted path). The development token is at least 24 characters, compared in constant time, refused when
  `NODE_ENV=production` or `production: true` (production mode cannot be turned off by an option once the environment sets it), and logs
  a warning when on. Startup also refuses no authentication at all, an http JWKS URL outside loopback, and a wildcard CORS origin.
- **CORS and CSRF** (`src/http/cors.ts`): exact origins only; `Access-Control-Allow-Credentials` is never sent; the README says the
  API reads no cookies, so CSRF does not apply.
- **Rate limit** (`src/http/rateLimit.ts`): token bucket per principal on `write` routes, burst 100 and 20 per second, per instance
  (documented), bounded table.
- **Routes** (`src/routes/`): `/health` (liveness; `ok`, `status`, `version`, `uptime`), `/health/ready` and `/ready` (database under a
  3 s deadline; transport reachability; last tick on the database's clock; no job data; 503 with the `storage` block the panel reads),
  `/capabilities` (declared by the process, `Infinity` delay is `null`), `/dashboard` and `/stats` (types defined here from the panel's
  clients; 501 `not_implemented` until `deps.dashboard` is given in task 31).
- **Contract tests** (`test/contract/`): `shapes/panel-types.ts` is a verbatim copy of the panel's `src/lib/types.ts` (panel commit
  `8ebf9328`, sha256 in the header); `shapes/panel-consumers.ts` is the panel's own `/health` and `/ready` decisions as pure functions;
  `shapes/schemas.ts` has zod schemas that must `satisfies` the panel's types. The served types are checked assignable to the panel's
  at compile time, and the served bodies parse with the schemas at run time.
- **OpenAPI** (`docs/openapi.yaml`, hand-written): the six core paths. `test/openapi.test.ts` fails when a route is served and not
  documented, or the reverse, when a `$ref` does not resolve, when an operation other than `GET /health` has no token requirement, and
  when a served body has a key the schema does not name or lacks one it requires.
- **Docs:** `packages/control-api/README.md`; DESIGN.md section 6 ("As built"); `docs/PORTING.md` (a note and two rows for the panel
  files copied into the contract tests; nothing in `../qelay` is ported by this task).

**Tests:** 178 in 13 files, all passing: `auth` 17, `auth.access` 7, `errors` 24, `pipeline` 20, `pipeline.edge` 9, `config` 38, `router` 9,
`capabilities` 9, `health` 15, `stats` 4, `server` 5 (a real socket), `contract/panel.contract` 10, `openapi` 11. The one real-Postgres case
is `postgresReadiness` against the test database (in `health`).

**Acceptance**

- Unauthenticated requests to anything except `GET /health` get 401, including unknown paths and wrong methods (`auth.access.test.ts`).
  `viewer` on a mutating route gets 403 (`auth.test.ts`, `auth.access.test.ts`).
- The development token with `NODE_ENV=production` fails at startup with a message naming OIDC (`config.test.ts`: `NODE_ENV`, the option, and the environment variables).
- `/capabilities` per transport: memory, the Postgres-local stub, Pub/Sub (emulator host set, no connection made) and SQS. **SQS is a
  literal declaration**: the `transport-aws` package does not exist yet, so task 40 replaces the literal with the real transport's
  `capabilities` and keeps the test (a comment in the test says so).
- Error bodies carry no stack trace and no SQL (`errors.test.ts`).
- Expired JWT, wrong audience, wrong issuer and unknown `kid` are all 401 (`auth.test.ts`), with an identical body for every reason.

**Found by the tests and fixed**

- `https://*.example.com` was accepted as a CORS origin, because the URL parser takes `*` in a host; it would never have matched. Now
  refused at startup.
- The in-process `Request` has no `Content-Length`, which hid the early 413 path; the harness now sets it as a socket does.
- The panel's connection test (`fetchHealthWithTimeout`) rejects a `/health` without `status` and an integer `uptime`; the first
  version of `/health` had neither.

**Compatibility findings, for task 34 (the panel is not edited here)**

1. **Error shape.** The panel's clients read `{ error: string }`; this service sends `{ error: { code, message, details? } }` as
   specified. The panel's error handling must read `error.message` (and may branch on `error.code`).
2. **`/healthz`.** The panel's diagnostics page also probes `/healthz` (plain `OK`, unauthenticated in Qelay). It is **not served**: a
   second unauthenticated route is a decision for the user, and `/health` does the job. Task 34 switches the probe.
3. **`/ready`** is served as an alias of `/health/ready` and **needs a token** (Qelay's did not). The panel sends one with every call.
4. **`ReadinessResponse.storage.diskFull`.** The panel types the not-ready branch with the literal `true`; this service sends `false`,
   because it does not report a full disk. Runtime-safe (the panel reads only `storage.error`); task 34 widens the panel's type.
5. The panel has no `/capabilities` client yet (task 34).

**Not done here, by design**

- No `bin` or Dockerfile: the process that wires the API to a store and a transport belongs to tasks 31 (routes) and 36 (deployment).
- Bulk-route time limits and the SSE stream (`idleTimeout` is already 255 s in `startControlApi`) are for tasks 31 and 32.
- The tick's Cloud Scheduler check in `packages/maintenance` still has its own RS256 verifier; it predates this package and is not
  changed. Moving it onto `jose` is a clean-up with no deadline.
- The rate limit is per instance: N instances give a caller N times the rate.

**Owed:** nothing for this task beyond the plan-wide Docker-backed gate.
