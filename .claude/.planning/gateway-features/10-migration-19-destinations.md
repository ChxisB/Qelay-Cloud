# 10 — Migration 19 destinations

**Status:** done · **Depends on:** 08 · **Touches:** packages/store-postgres

## Goal
Migration 19: `qcloud_webhook_destinations` and `destination_id` on webhooks; create, read, update and remove.

## Steps
1. DDL with a composite foreign key that restricts removal; `webhookDestinations.ts`.
2. `create` accepts `destinationId` and copies the address; `updateDestination` rewrites the copies and re-runs the loop check.

## Acceptance
- A route made from a destination has its url or target and the id.
- Changing a destination changes every connection's address in one transaction; a queue change that would loop is refused and nothing changes.
- A destination in use cannot be removed.
- At most 100 destinations; names are unique within the namespace.

## Verify
```bash
QCLOUD_REQUIRE_DB=1 bun test packages/store-postgres
```

## Risks / notes


## Result
Migration 19 (ddl/webhookDestinationTable.ts, 'saved destinations'): qcloud_webhook_destinations (namespace+id key, unique name per namespace, kind http|queue with url/target checks) and a nullable destination_id on qcloud_webhooks with a composite ON DELETE RESTRICT key and a partial index; no data change, old releases keep working (verified: an insert that names no destination_id still works after the migration). Store (store/webhookDestinations.ts, WebhookApi: destinations, getDestination, createDestination, updateDestination, deleteDestination): create/update/delete take the namespace 'webhooks' advisory lock (the one a webhook save takes); create checks name and the 100 cap (core MAX_DESTINATIONS); a webhook made with destinationId copies kind, url and target in the creating transaction (KEY SHARE on the destination), and the spec may not also give an address; updateDestination rewrites every copy in the same transaction and re-runs the loop and chain check for a queue address (nothing changes on refusal); the kind is fixed, name and address change; delete is refused while in use (DestinationInUseError). New errors DestinationNameTakenError, DestinationLimitError, DestinationInUseError; WebhookRecord.destinationId; checkAddress extracted from webhookValidate so route and destination share one address check. Snapshot regenerated and reviewed; 3 planned rows (name check, webhooks of a destination, the list's count) use the new indexes. Tests: webhook.destinations.test.ts (12, including a create-versus-delete race and loop refusal; mutation-checked: removing the rewrite and the loop check fails 2), schema.migrate.destinations.test.ts (2). Ran on local PG 18.6: whole store-postgres 1821 pass, 22 skip, 0 fail (read.plans.aux passed this time); core 165 pass; typecheck, oxfmt, oxlint, architecture clean. A destination holds no secret: each webhook keeps its own signing secret. Not run: Docker-backed suites. Not done: detaching a webhook from its destination.
