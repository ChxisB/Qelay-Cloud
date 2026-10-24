# 03 — Migration 20 and store: sources, requests, accept with fan-out

**Status:** done · **Depends on:** 02 · **Touches:** packages/store-postgres, packages/core
**Gate:** migration (approved 2026-10-23)

## Goal
Sources and requests are stored, a route can name an inbound source, and accepting a request makes its deliveries in one
transaction. Nothing the previous release reads or writes is changed.

## Steps
1. Migration 20, additive only, `pg_advisory_xact_lock` only:
   - `qcloud_sources` (namespace, id, name, token hash, verification kind, sealed secret, enabled, created and updated at).
   - `qcloud_requests` (namespace, id BIGSERIAL, source id, received_at, method, headers JSONB, query JSONB, content_type, body
     BYTEA, status `accepted` or `rejected`, cause).
   - `qcloud_webhooks.source_id` (nullable), `qcloud_deliveries.request_id` (nullable) with a partial unique index
     `(namespace, webhook_id, request_id, created_at) WHERE request_id IS NOT NULL`.
   - Requests are partitioned by `received_at` day like deliveries if the partition helpers allow it without new tick code;
     otherwise a plain table with a retention index, recorded in the Result.
2. `webhookValidate`/`webhookRecord` accept a route with `source` (and still `events` and `queue`, until task 06).
3. Store calls: create, list, read, update, rotate and delete a source; `acceptRequest` inserts the request and one delivery per
   eligible route in one transaction (route enabled or held; filter; dedupe by atomic upsert; shape; delay), and returns
   what it made; a rejected request is stored with a cause under a per-source per-minute cap.
4. Regenerate `schema.snapshot.txt` (`QCLOUD_UPDATE_SNAPSHOT=1`) and add rows to `schema.indexes.test.ts` for each new query path.

## Acceptance
- A request to a source with two routes makes two deliveries; a route whose filter does not match makes none (test).
- Two concurrent accepts of the same dedupe key inside the window make one delivery between them (test, 20 parallel).
- A rejected request over the cap per minute is counted and not stored (test).
- The migration applies on a database at version 19 with rows in it, and `SchemaDriftError` is not raised (test).
- `schema.snapshot.txt` diff is reviewed and only adds.

## Verify
```bash
QCLOUD_REQUIRE_DB=1 bun test packages/store-postgres packages/core
```

## Risks / notes
- Fan-out in the ingest's transaction holds one connection for a few statements; the load check in task 10 measures it.

## Result
Done 2026-10-23.

**Changed**
- Migration 20 (`schema/ddl/inboundSources.ts`, registered in `migrations.ts`): `qcloud_sources`, `qcloud_requests`,
  `qcloud_webhooks.source_id` (FK restrict), `qcloud_deliveries.request_id` with a partial unique index, and the `events` check
  relaxed to `cardinality(events) >= 1 OR source_id IS NOT NULL`. Additions only, no lock but `pg_advisory_xact_lock`.
- Store: `store.sources` (`SourceApi`: create, list, get, update, rotateSecret, rotateToken, delete, findByToken, accept, reject)
  in `inboundSources.ts`, `inboundCredentials.ts`, `inboundAccept.ts`, `inboundApi.ts`, `inboundRows.ts`, `inboundTypes.ts`.
  Routes take a `source` (create, update, validate); a source route has no events and no queue, never needs the writer, and
  is left out of the loop check.
- Core: the event-document, filter, shape and dedupe work from task 02 is what `acceptRequest` calls.

**Decisions recorded here**
- `qcloud_requests` is a plain table with a retention index, not partitioned by day: the delivery partition helpers are specific
  to `qcloud_deliveries` and another table would need new tick code. Task 04 deletes old rows in batches by that index.
- A source's verification is not editable after creation (make another source and move routes with the route's `source`).
- Token rotation is in the store because a source with routes cannot be deleted and a leaked URL needs a way out.
- The rejected-request cap is 60 stored per source per minute (D12 gives no number); the rest are counted in `rejected_dropped`.
- Request list, get and replay belong to task 05; retention to task 04. A source lookup cache is a possible task 07/10 change.

**Acceptance**
- Two routes make two deliveries, a filter miss makes none: `inbound.accept.test.ts`.
- 20 parallel accepts of one dedupe key, across two store handles, make one delivery; the window reopens after it: same file.
- A rejected request over the cap is counted and not stored, also across two processes: same file.
- Version 19 with rows migrates to latest, a second `migrate` raises no `SchemaDriftError`, and the previous release's inserts
  (no `source_id`, no `request_id`) still work: `schema.migrate.inbound.test.ts` (3 tests).
- `schema.snapshot.txt` regenerated and reviewed: only additions, apart from the `events` check being relaxed.
- A row in `schema.planned.inbound.ts` for each new index (token, name, routes by source, requests by source, all requests,
  retention, delivery by request). The seed interleaves another namespace and a quiet source so the listings need their own
  indexes. The request-list and retention rows are the shape task 04 and 05 will use: replace them with the real statements there.

**Ran (local Postgres 18 on 127.0.0.1:55442, `QCLOUD_REQUIRE_DB=1`)**
- `bun run typecheck && bun run lint && bun run format:check && bun run architecture`: pass (lint 0 errors; the panel's
  pre-existing react warnings are unchanged).
- `bun test` in full: 6036 pass, 252 skip, 1 fail. The failure is `test/docs/release.test.ts` (per-package LICENSE still names
  the upstream holder): pre-existing and the owner's call, not loosened.

**Not run**
- The Pub/Sub, SQS, PgBouncer and TLS suites (their emulators are not up here; the 252 skips), `test:model` (no queue
  semantics changed), and anything against a real cloud (D9).
