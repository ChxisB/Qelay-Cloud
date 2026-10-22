# 08 — Migration 16: a destination on a connection

**Status:** done · **Depends on:** 07 · **Touches:** packages/store-postgres, packages/core · **Gate: migration**

## Goal
A `qcloud_webhooks` row can say where its deliveries go: `http` (today) or `queue`, and a route cannot be saved if it would make a loop.

## Steps
1. Migration 16 (D11): `destination text not null default 'http'` checked against `http` and `queue`, and `target text null`
   (the queue) on `qcloud_webhooks`. `url` stays `not null` and holds `''` for a queue route. Additive, a default, no rename,
   no drop, `pg_advisory_xact_lock` only.
2. Core types and the store port: `destination` and `target`, validation at the boundary (a `queue` route needs `target` and a
   source `queue`; an `http` route needs `url` and no `target`).
3. The save check (D11): create, a change of queue or destination, and enable read every route of the namespace under
   `pg_advisory_xact_lock`, treat each as an edge source queue to target queue, and refuse `409 route_cycle` and
   `409 route_chain_too_long` (longest chain over 5). Tests: a self loop, A to B to A, a chain of six, two concurrent saves
   that would close a cycle between them (one is refused), enabling a disabled route that closes a loop.
4. Regenerate `schema.snapshot.txt` (`QCLOUD_UPDATE_SNAPSHOT=1`) and review its diff; a row in `schema.indexes.test.ts` for a
   new query path, if any.
5. The current sender fed a queue-route delivery with `destination` ignored (what an old release does) fails it without a
   request and does not crash. That is why the runbook says to add the first queue route after every tick runs the new release.

## Acceptance
- Migration applies on a database holding webhooks and leaves them `http` (test).
- A route set that would loop or chain past 5 is refused on save (tests above).
- Checksum of migrations 1 to 15 unchanged (existing drift test).
- `schema.snapshot.txt` diff is only the two columns and the check.

## Verify
```bash
docker compose -f docker-compose.test.yml up -d --wait
QCLOUD_REQUIRE_DB=1 bun test packages/store-postgres packages/core
```

## Risks / notes
- Needs Postgres up with `QCLOUD_REQUIRE_DB=1`.

## Result

Done 2026-10-21, on local Postgres 18 (Homebrew, 127.0.0.1:55442), `QCLOUD_REQUIRE_DB=1`.

**Changed**
- `schema/ddl/webhookDestinations.ts` and `migrations.ts`: migration 16, `destination` (default `http`, checked) and `target`
  (nullable) on `qcloud_webhooks`, plus a check that a `queue` route has a target and an `http` route has none. Migrations 1 to 15 untouched.
- `core/src/webhookRoute.ts` (+ test): `WEBHOOK_DESTINATIONS`, `MAX_ROUTE_CHAIN = 5`, and `routeProblem(edges)`, the pure
  cycle and longest-chain check (a cycle is reported before a chain).
- `store-postgres`: `WebhookSpec`/`WebhookRecord` carry `destination` and `target` (`url` is optional in the spec and `''` on
  a queue route); `validateDestination` in `webhooks.ts`; `webhookRouteCheck.ts` reads every queue route of the namespace
  and throws `RouteCycleError` or `RouteChainError` (new in `errors.ts`, exported). It runs after the write, so a refusal
  rolls the whole save back, on create and on enable. Enable now takes the same `webhooks` advisory transaction lock as create.
- Tests: `test/webhook.routes.test.ts` (18), a row in `schema.planned.webhook.ts` for the route read (primary key), the
  regenerated `schema.snapshot.txt` (diff: two columns and two checks, nothing else), and a sender test in
  `maintenance/test/webhook.send.test.ts` (a delivery with an empty url fails without a request or a lookup).

**Ran:** `bun test packages/store-postgres packages/core packages/control-api packages/maintenance` with Postgres up:
2953 pass, 23 skip, 0 fail (the skips are the PgBouncer, TLS and emulator suites, which were not up). `typecheck`,
`format:check` and `architecture` pass; `lint` has only the warnings that were there. The race test fails when the advisory
lock is taken out (checked by hand), so it does guard the lock.

**Notes**
- There is no store call that changes a route's queue or destination, so the "on a change" check has nothing to attach to.
  If task 10 adds one, it must call `assertRoutesAcyclic` under the same lock.
- A disabled route counts in the check, so a loop cannot be parked and switched on later. Enable re-checks anyway.
- Not run: `bun run test:model` (task 09 runs it, once a delivery can add a job), the PgBouncer and TLS suites, Docker.
