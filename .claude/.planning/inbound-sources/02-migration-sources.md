# 02 — Migration 17 and store: sources, requests, a route's source

**Status:** todo · **Depends on:** 01 · **Touches:** packages/store-postgres, packages/core

## Goal
Sources and requests are stored, and a route can name an inbound source, without changing what the previous release reads or writes.

## Steps
1. Migration 17, additive only: `qcloud_sources` (id, namespace, name, token hash, verification kind, encrypted secret, enabled, caps), `qcloud_requests` (id, source, received at, method, headers, query, body, status accepted or rejected, cause), `source_id` (nullable) on `qcloud_webhooks` and `request_id` (nullable) on `qcloud_deliveries`. A route has a queue filter or a source, never both (a check that every old row satisfies, since old rows have no source).
2. Store calls for sources, requests and the accept step (insert the request and its events in one transaction), with a route's loop check unchanged (a source has no incoming edge).
3. Regenerate `schema.snapshot.txt` and add a row to the planned-index tests for each new query path; the drift manifest picks up the new DDL.

## Acceptance
- Old rows read unchanged and an old tick binary still sends (test with the previous release's sender suite, unedited).
- The accept step writes the request and one event per enabled route in one transaction, and none when the source is disabled (test).
- A token is stored hashed and compared in constant time (test).

## Verify
```bash
QCLOUD_REQUIRE_DB=1 bun test packages/store-postgres packages/core && QCLOUD_UPDATE_SNAPSHOT=1 bun test packages/store-postgres/test/schema
```

## Risks / notes
- Gate: a migration. Forward-only; never edit a shipped migration. Run `bun run test:model` only if the claim or complete paths change (they should not).
- A retention column or index on `qcloud_requests` decides how big the table can get; record the size estimate in the Result.

## Result
