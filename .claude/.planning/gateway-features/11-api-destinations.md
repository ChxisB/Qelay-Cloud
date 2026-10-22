# 11 — Api destinations

**Status:** done · **Depends on:** 10 · **Touches:** packages/control-api, docs/openapi.yaml

## Goal
Destination routes and `destinationId` on create.

## Steps
1. `GET/POST /webhooks/destinations`, `PATCH/DELETE /webhooks/destinations/{id}`; the URL goes through `validateWebhookUrl`; read-only callers see the origin only.
2. openapi, route docs, audit with ids.

## Acceptance
- A URL that fails the address check is refused on a destination as on a webhook.
- A destination in use answers 409.
- The openapi test matches.

## Verify
```bash
bun test packages/control-api
```

## Risks / notes


## Result
Routes GET/POST /webhooks/destinations and PATCH/DELETE /webhooks/destinations/{id} (routes/webhookDestinations.ts, jobs/webhookDestinationModel.ts), registered in jobsModule. The URL goes through validateWebhookUrl on create and on a url patch, with the same 400 codes as a webhook. A viewer sees the origin only and cannot write. Audit rows hold ids only (destination=<id>, id=<id>). Errors: destination_name_taken, destination_limit, destination_in_use (details.connections) answer 409; route_cycle and route_chain_too_long already mapped. POST /webhooks takes destinationId (refused with destination, url or target, and for an unknown id: 400 unsupported_option); the Webhook wire and schema gain destinationId. openapi.yaml has the paths, Destination schemas, the create body and Webhook; the Conflict description lists the new codes; security and reference route docs regenerated. Ran on local PG 18.6: packages/control-api 714 pass, 0 fail (10 new destination tests, 1 new openapi fit test); typecheck, oxfmt, architecture (1687 files) clean; oxlint only existing panel warnings; docs:check passed. Not run: Playwright, Docker-backed suites.
