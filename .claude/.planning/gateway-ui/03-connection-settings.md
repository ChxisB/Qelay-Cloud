# 03 — Connection Settings tab: rules, rotate secret, danger section

**Status:** done · **Depends on:** 02 · **Touches:** packages/panel/src (gateway/, lib/bq/resourceApi.ts), packages/panel/test

## Goal
The Settings tab shows what a connection does to an event, in order, and holds the secret and the destructive actions.

## Steps
1. `ConnectionSettings.tsx`: **Rules** as an ordered read-only pipeline of cards: Filter (the filter in words, or "off"),
   Shape (the body in words, or "default body"), Rate (60 attempts a minute), Retry (the schedule from
   [webhooks.md](../../../docs/webhooks.md), as one sentence), Auto-pause (after 20 failures in a row). Each says on or off.
   Read-only: editing is G3.
2. **Signing secret** (http routes only; a queue route says "not signed"): `Rotate secret` with a confirm. It calls
   `bq.rotateWebhookSecret(id)` (new client call to the existing route), shows the new secret once with a copy button and
   the line "The old secret keeps working for 24 hours", and clears it when the page is left. `409 webhook_key_missing`
   says the deployment has no signing key.
3. **Pause** (the on/off switch, in words: events wait and are sent when resumed) and **Remove** (confirm; goes back to the
   list). Same actions as the list, one place each.

## Acceptance
- A route with a filter and a shape lists them; one without says off for both. A queue route has no secret section.
- Rotating shows the secret once; it is not in the address, `localStorage` or a toast; leaving the page and returning
  shows nothing. A key-missing answer shows its message.
- Remove asks first, and a removed connection returns to the list.

## Verify
```bash
bun test packages/panel/test/gateway-connection-settings.test.tsx
bun run typecheck
```

## Risks / notes
- The secret is on screen once. The test asserts the page's `localStorage` and the address stay free of it.
- The retry sentence must match the sender; the test reads the schedule from constants in `connectionRules.ts` that link to
  webhooks.md in their comment, and it also reads docs/webhooks.md so a change of the guide fails the test.

## Result

**Changed**
- New: `gateway/connectionRules.ts` (`RETRY_WORDS`, `RATE_PER_MINUTE`, `PAUSE_AFTER`, `ruleCards`), `gateway/ConnectionSettings.tsx`
  (Rules, Signing secret, Pause, Remove), `test/gateway-connection-settings.test.tsx` (12 tests).
- `ConnectionPage.tsx`: a Settings tab, the remove-failed banner, `key={route.id}` on the settings so a secret never
  follows to another connection. `useRouteActions.remove` now returns whether the connection was removed.
- `lib/bq/resourceApi.ts`: `rotateWebhookSecret(id)` (the existing `POST /webhooks/{id}/rotate-secret`, no body, no new route).
- `App.tsx` route `/events-gateway/connections/:id/settings`, `pageTitle.ts`, `app-routes-complete.test.tsx`, and a demo reply
  for `/rotate-secret` (`demo/api.ts`).

**Behaviour worth knowing**
- An unsigned connection's button says "Create secret" (the same call), a signed one's says "Rotate secret".
- The new secret is component state only; Done, leaving the page or another id clears it. Tests assert it is not in the
  address, `localStorage`, `sessionStorage` or a toast. Mutation check: dropping `key={route.id}` fails the
  "leaving clears it" test.
- `webhook_key_missing` shows the panel's own words (set `QCLOUD_WEBHOOK_KEY`); any other refusal shows the server's.
- The Pause words say only what holds for a manual pause and an automatic one: resume sends what was held, and an event
  not sent within 24 hours of being due expires.
- Rules are read-only (G3). The rate, retry and pause numbers are the documented deployment defaults; no read returns a
  deployment's own, so a deployment that changed them would see the defaults here. The test pins them to docs/webhooks.md.

**Ran (local PG 18 not needed, panel tests only)**
- `bun test packages/panel`: 1645 pass, 0 fail. `bun run typecheck` clean. `bun run lint` exit 0 (no warning in the new
  files). `bun run format:check` clean. Every gateway file is under 300 lines (largest 240).

**Not run**: Playwright e2e and the 390/1440 sweeps; the full gate with Postgres (task 06).

**Found, not changed**: `docs/openapi.yaml` (setWebhookEnabled) says a hand-disabled webhook "gets no new deliveries" while
`docs/webhooks.md` says a paused one "still collects deliveries". The panel's wording avoids the difference; task 06 should
raise it with the owner.
