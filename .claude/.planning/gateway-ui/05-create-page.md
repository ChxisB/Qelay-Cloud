# 05 — Create connection as a guided page

**Status:** done · **Depends on:** 02 · **Touches:** packages/panel/src/pages/control/gateway, packages/panel/src/App.tsx, packages/panel/test

## Goal
"New connection" opens one page that walks through source, destination, rules and save, and lands on the new connection.

## Steps
1. Route `/events-gateway/connections/new` (before `:id` in `App.tsx`; `new` is not a valid id, so the two cannot clash:
   assert that in a test).
2. `CreateConnection.tsx`: a vertical step rail (Source, Destination, Rules, Save) on one page. Source is the queue;
   destination is the kind switch (address or queue) with its fields; rules is the events to send and, for an address,
   the signing secret. The fields and `buildWebhookBody` are the ones of `ConnectionForm`; split `ConnectionForm` into step
   components so the inline card and the page share them, or retire the inline card if the page replaces it.
3. Save adds the connection and navigates to `/events-gateway/connections/<id>`. If the API answers without an id, go to
   the list. A refusal (`route_cycle`, `unsupported_option`, a bad URL) shows beside the step it belongs to.
4. "New connection" on the list becomes a link to the page. The empty state's call to action too.

## Acceptance
- An address connection and a queue connection can each be created from the page, with the same body the old form sent.
- A loop (`route_cycle`) and a missing target show their message and keep what was typed.
- Saving opens the connection page; Cancel returns to the list and nothing is sent.
- `/events-gateway/connections/new` renders the page, not "no longer exists".

## Verify
```bash
bun test packages/panel/test/gateway-connections.test.tsx packages/panel/test/gateway-create.test.tsx
bun run typecheck
```

## Risks / notes
- Replacing the inline card changes tests that drive it: they move with it, none is loosened.
- The "reuse an existing destination" choice of Hookdeck is G5 and is not offered.

## Result

**Changed**
- New: `gateway/CreateConnection.tsx` (the page: header, card, Cancel link, lands on the new connection),
  `test/gateway-create.test.tsx` (12), `test/gateway-create-secret.test.tsx` (3), `test/gateway-create.helpers.tsx`.
- `ConnectionForm.tsx` (277 lines) is now four numbered steps (Source, Destination, Rules, Save) on a rail. The fields,
  names, labels and `buildWebhookBody` call are the ones it had. `onAccepted` receives the server's reply; an optional
  `cancel` slot sits beside the Add connection button.
- `Connections.tsx`: the inline "Add connection" card is gone. "New connection" is a link in the header and in the empty
  state. `model.ts` has `NEW_CONNECTION`; `App.tsx` has the lazy route before `:id`; `pageTitle.ts` and
  `app-routes-complete.test.tsx` know the path (the nav item already covered `/events-gateway/connections/*`).
- Moved, not loosened: the queue-connection body, the refused queue route and both signing-secret tests (now on the page);
  the same-tick add test of `server-action-pages-03` (now "two presses in one tick send one connection"). That file keeps
  the same-tick remove. `gateway-connections.test.tsx` now asserts the list has no form and links to the page.

**Behaviour worth knowing**
- Save finds the id in `data.webhook.id` of the 201 reply. A reply without one lands on the list, never on a made-up id.
- A refusal stays on the page with everything typed kept. `route_cycle` shows in Destination, `webhook_key_missing`
  (a secret on a deployment with no key) in Rules, every other refusal and every typed-input check at Save.
- The signing secret is typed or generated on this page and sent once; nothing is stored (a test checks both storages).
- `new` is a static path, so the router ranks it above `:id` whatever the order; a test renders the routes in the
  opposite order to prove it.
- Mutation checks: ignoring the id fails "Save opens the connection it made"; not routing `route_cycle` fails "a loop is
  shown in the Destination step".

**Ran (panel tests only, no Postgres needed)**
- `bun test packages/panel`: 1670 pass, 0 fail. `bun run typecheck` and `bun run format:check` clean. `bun run lint`: no
  new warning (the form's existing `set-state-in-effect` on its scope-reset effect remains).
- `bun run scripts/check-file-size.ts`: every file of this task is under 300 lines. It still fails on
  `packages/panel/test/nav-shell.test.tsx` (307), which is the nav work, not this task.

**Not run**: Playwright e2e and the 390/1440 sweeps. `e2e/webhooks.e2e.ts` still drives the pre-gateway UI (`/webhooks`,
"New webhook", "Add webhook") and was stale before this task; it needs a rewrite that can be run.

**Not done**: "reuse an existing destination" (G5).
