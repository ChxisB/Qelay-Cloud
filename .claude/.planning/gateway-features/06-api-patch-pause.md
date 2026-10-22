# 06 — Api patch pause

**Status:** done · **Depends on:** 05 · **Touches:** packages/control-api, docs/openapi.yaml

## Goal
`PATCH /webhooks/{id}`, `mode` on `PUT /webhooks/{id}/enabled`, and the wire fields.

## Steps
1. Strict zod bodies in `webhookModel.ts`; routes in `routes/webhooks.ts` (split a file if it nears 300 lines).
2. `toWebhookWire` carries name, description, delay, dedupe, and `pausedBy` (`operator`, `failures` or null).
3. openapi, `docs/reference/routes.md`, `docs/security/routes.md`; an audit row naming the id.

## Acceptance
- PATCH is operator-only, strict, and its audit row holds the id and no value.
- A read-only role cannot PATCH; a read-only read sees the URL origin as before.
- `mode: hold` and `mode: ignore` reach the store; the default is `ignore`.
- The openapi test matches the served routes.

## Verify
```bash
bun test packages/control-api
```

## Risks / notes


## Result
PATCH /webhooks/{id} (operator-only, strict, audit by id, no values) and mode hold|ignore on PUT /webhooks/{id}/enabled; wire gains name, description, delayMs, dedupe, pausedBy; create takes the four rule fields. New webhooks.update.test.ts (9 tests); openapi (PATCH, mode, Webhook/WebhookCreate/WebhookPatch/WebhookDedupe) with the openapi test pinned and extended; routes docs regenerated. Ran on local PG 18: bun test packages/control-api 687 pass 0 fail; typecheck, oxlint, format:check, architecture, docs:check clean. Not run: panel e2e.
