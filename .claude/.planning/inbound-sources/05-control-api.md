# 05 — Control API and openapi: sources, requests, replay, a route's source

**Status:** done · **Depends on:** 03, 04 · **Touches:** packages/control-api, docs/openapi.yaml
**Gate:** new routes (approved 2026-10-23)

## Goal
An operator manages sources, reads requests, replays one, and points a route at a source.

## Steps
1. `/sources` (list, create, read, patch, delete, rotate secret). A create returns the URL token and the secret **once**. A read
   never returns a secret; a viewer sees the token cut.
2. `/requests` (list by keyset with source and status filters, read one with its headers, query, body and the deliveries it
   made) and `POST /requests/{id}/replay` (re-evaluates the source's current routes and makes new deliveries).
3. A route's create, patch and read carry `source`. `events` and `queue` stay accepted until task 06.
4. Writes need the operator role and are audited by id. `openapi.yaml` and the served routes match (the openapi test).

## Acceptance
- A viewer cannot create, rotate, delete or replay (test); an operator can, and each write is audited (test).
- A secret appears in the create response once and in no read, log or audit entry (test).
- `GET /requests` pages by keyset without skipping or repeating (test).
- The openapi test passes.

## Verify
```bash
QCLOUD_REQUIRE_DB=1 bun test packages/control-api
```

## Result
**Done 2026-10-23.**

**Changed**
- Ten routes, all in `packages/control-api/src/routes/`: `sources.ts` (`GET|POST /sources`, `GET|PATCH|DELETE /sources/:id`,
  `POST /sources/:id/rotate-secret`, `POST /sources/:id/rotate-token`) and `requests.ts` (`GET /requests`, `GET /requests/:id`,
  `POST /requests/:id/replay`). Wires and bodies are in `jobs/sourceModel.ts`.
- A route carries `source`: `webhookBody` and `patchBody` take it, `WebhookWire` returns it, and `events` became optional on
  create (the store says which of events, queue and source may be combined). `events` and `queue` are still accepted until 06.
- `errors.ts` maps `source_limit`, `source_name_taken` and `source_in_use` (all 409, fixed text). Replay answers 404
  `request_not_found` and 409 `request_not_replayable`.
- `docs/openapi.yaml` (paths and schemas), and the generated `docs/security/routes.md` and `docs/reference/routes.md`.
- Tests: `sources.test.ts` (7), `requests.test.ts` (4), `openapi.sources.test.ts` (2); `openapi.webhooks.test.ts` pins `source`.

**Decisions (not in the plan)**
- The create response carries the URL **token**, not a URL: no ingest base URL is configured yet. The URL is the ingest origin
  plus `/s/<token>`; the panel (08) and the runbook (11) say so.
- `secret` is in the response only when the store made it. A secret the caller chose is not echoed.
- Step 1's "a viewer sees the token cut" does not apply: the token is shown once and no read returns it, to anyone.
- A viewer reads a request's metadata, headers and query, but `body` is `null` with `bodyRedacted: true`. Headers are redacted
  by the store before they are saved.
- Replay is allowed on a disabled source, skips dedupe, and applies each route's filter and shape. A replay in the same
  millisecond as the accept (or the one before) makes nothing, because the delivery key is `(route, request, created_at)`.
- The `status` filter on a source's request list is a filter on the source index, so it scans until the page fills. It is
  bounded by retention.

**Ran, against local Postgres 18 (`127.0.0.1:55442`, `QCLOUD_REQUIRE_DB=1`)**
- `bun test packages/control-api test/docs`: 749 pass, 1 fail (below). Acceptance: viewer 403 on every write and audit rows
  by id, with no token or secret in any read or audit entry (`sources.test.ts`); keyset paging with no skip or repeat
  (`requests.test.ts`); the openapi test.
- Typecheck, format, architecture and `docs:check` (with the 7 documented blocks run) pass. Lint has 0 errors; the panel
  warnings were there before.
- Full `bun test`: 6077 pass, 252 skip, 3 fail.
  - `release.test.ts` LICENSE check: the owner's call, not touched.
  - `docs/security/routes.md` was stale for the new routes: regenerated with `bun run security:routes --write`, test passes.
  - `read.plans.aux.test.ts` "throughput of the whole fourteen days": a planner test on `qcloud_metric_buckets`, which this
    work does not touch. It passes alone and failed 2 of 3 runs of its own file, so it is flaky, not changed by 05.
    Not edited.

**Not run:** Docker-backed suites, Pub/Sub, ElasticMQ, PgBouncer and TLS (skipped with warnings, deferred to the end); any
real cloud (D9).
