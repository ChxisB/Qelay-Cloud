# 10 — Control API and OpenAPI: destinations and bulk retry

**Status:** done · **Depends on:** 09 · **Touches:** packages/control-api, docs/openapi.yaml · **Gate: new routes**

## Goal
`/webhooks` accepts and returns `destination` and `target`, and a set of failed deliveries can be retried in one call.

## Steps
1. `POST /webhooks` and `GET /webhooks/{id}` carry `destination` (default `http`) and `target` (a queue name); `url` is
   required only for `http`. A save that would loop answers `409 route_cycle` or `409 route_chain_too_long`. Old clients that send and read only `url` keep working (the response adds fields, removes none).
2. New `POST /webhooks/{id}/deliveries/retry` with `{ status: 'failed', before?, limit? }` (at most 500, operator role,
   audited as `webhook=<id>` only), answering how many were reset.
3. `openapi.yaml` and the served routes match (the openapi test). Role and audit rules as for the other webhook writes.
4. Two reads for the Hookdeck-style screens (task 11) and Home (task 13), both viewer-readable and never returning a secret:
   `GET /webhooks/deliveries` (the namespace's events across every route: keyset cursor, `status`, `webhook`, `since`,
   `until`, `limit` at most 100) and `GET /webhooks/stats` (`since`, `until`, optional `webhook`: counts by status,
   failure ratio, average attempts, pending and oldest pending, and response latency average, p95 and max, bucketed for a
   chart). Today the history is per webhook only.

## Acceptance
- An old-shape create still returns 201 with `destination: 'http'` (test).
- A viewer sees a `queue` target in full and an `http` url as its origin only (as today).
- The two 409 codes are in `openapi.yaml` and a test posts a loop.
- `GET /webhooks/deliveries` pages across routes by one cursor and filters by status and route (test); `GET /webhooks/stats`
  matches a hand count on a fixture of deliveries and attempts (test).
- Bulk retry resets only `failed` rows of that webhook and never more than `limit` (test); a viewer gets 403.

## Verify
```bash
QCLOUD_REQUIRE_DB=1 bun test packages/control-api && bun test test/docs
```

## Risks / notes
- The two reads are new query paths: each gets a row in `schema.planned.*`, and if either needs an index it is a migration, so stop and ask. If they would change a `StateStore` interface, stop and ask.
- Blocked until 09. A route registry change is a public API change: the owner approves the openapi diff.

## Result

Done 2026-10-21.

**What changed**
- `store-postgres` (read and bulk-write paths, no migration): `webhookFeed.ts` (`listAllDeliveries`, `retryFailedDeliveries`,
  `MAX_BULK_RETRY` 500) and `webhookStats.ts` (`webhookStats`: counts by outcome per bucket, the backlog and its oldest, receiver
  latency average, p95 and max from each delivery's kept history). They are the `deliveriesAll`, `retryFailed` and `stats`
  members of the `webhooks` facet (`WebhookApi`, not the `StateStore` interface). Six rows in `schema.planned.webhook.ts`
  (the feed by the primary key, the per-route window and the bulk retry by `qcloud_deliveries_history_idx`, the stats statements
  by the window or pending indexes already there). 7 tests in `webhook.feed.test.ts`.
- `control-api`: `POST /webhooks` takes `destination` and `target` (`url` only for `http`; the store refuses a missing or
  surplus field with 400 `unsupported_option`); `RouteCycleError` and `RouteChainError` answer 409 `route_cycle` and 409
  `route_chain_too_long` (`details.limit`); `GET /webhooks/deliveries`, `GET /webhooks/stats` and `POST /webhooks/:id/deliveries/retry`
  (operator, audited as `webhook=<id>`, answers `{ retried }`, 404 for an unknown route). The wire adds `destination` and
  `target` to a webhook and `routedJobId` to a delivery (core's `routeJobId` of the delivery id, set only for a delivered
  `queue` route). A viewer reads a `queue` target in full, and an `http` url as its origin, as before.
- `docs/openapi.yaml`: the three paths, `destination` and `target` on `Webhook` and `WebhookCreate` (`url` no longer required
  there), `routedJobId`, and four new schemas. `docs/security/routes.md` regenerated (110 routes).
- Tests: `webhooks.gateway.test.ts` (9, Postgres): an old-shape create, a queue route and a viewer's view of it, the fields each
  destination needs, a loop and a chain of six refused, the feed across routes (one cursor, route and status filters, window),
  `routedJobId`, stats against a hand count and the 7-day cap, bulk retry (only that route's failed rows, newest first, at most
  `limit`, 403/404/400). `openapi.webhooks.test.ts` pins the new bodies, and its create-body list gained the two fields.

**Decisions**
- The all-routes feed allows `limit` up to 200 (the per-route history's cap), not the 100 the plan guessed.
- No new index. The all-routes feed is served by the primary key `(id DESC)` filtered by namespace.
  shortcut: that scan reads other namespaces' rows too; an index on `(namespace, id DESC)` would be a migration, so it waits
  for the owner if a deployment with many namespaces shows it.
- `GET /webhooks/stats` for an unknown `webhook` counts nothing instead of answering 404.

**Ran** (local Homebrew Postgres 18 on :55442, `QCLOUD_REQUIRE_DB=1`)
- `bun test packages/control-api test/docs packages/store-postgres/test/webhook`: 809 pass, 2 fail before
  `security:routes --write`. One was the stale routes table (fixed); the other is the LICENSE test that fails at `HEAD`.
- `schema.indexes.test.ts` with the new rows: 132 pass with `webhook.feed.test.ts`.
- `typecheck`, `format:check`, `architecture` pass; `lint` only has the warnings that were there.

**Not run, or open**
- **Owner sign-off:** the new openapi routes (`GET /webhooks/deliveries`, `GET /webhooks/stats`,
  `POST /webhooks/{id}/deliveries/retry`) and the added fields.
- The store's stats are read from each delivery's bounded history, over a window of at most 7 days; retention (2 days by default)
  is what limits it in practice.
