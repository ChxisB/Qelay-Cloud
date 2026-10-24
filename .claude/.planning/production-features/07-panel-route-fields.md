# 07 — Panel: schedule and batch on a connection

**Status:** doing · **Depends on:** 06 · **Touches:** packages/panel/src/pages/control/gateway
**Design:** none (reuses existing pages and parts)

## Goal
The connection form sets a send schedule and a batch size, and the connection page shows them.

## Steps
1. A 'Send at' field (a preset list: every hour, nightly at 00:00, custom cron) with a time zone select, and a 'Send in batches' toggle with size.
2. Show next send time on the connection card. Plain sentence-case copy; status as word and glyph.
3. Demo data and the stub carry the fields. No new dependency.

## Acceptance
- The form saves and the page shows the schedule and the next fire; a bad cron shows the API's message.
- Panel guard tests, build and axe pass; the new controls have names and keyboard focus.

## Verify
```bash
bun run --cwd packages/panel build && bun test packages/panel
```

## Result
Done. A connection's form (new and settings) has a **Send** select (as soon as they arrive, every hour, every night at midnight, every Monday at
midnight, or a cron), a **Time zone** select (the viewer's zone first, then every zone the browser lists, plus the saved one if it is not listed),
and, for a webhook address, a **Send in batches** switch with *Events per request* (1 to 500, empty is 100) and *Most data per request (KiB)*
(1 to 1,024, empty is 256). A queue destination shows no batch controls and sends none. The settings page saves only what changed (null clears
a schedule or batch). The connection card and the "what it will do" preview show *Scheduled* and *Batched* with the next send time, read in the
schedule's own zone.

Next send time: the panel has no cron parser or zone data, so the API returns it. This added a wire field after task 06: `nextSendAt` (epoch ms, null
without a schedule) on `Webhook`, computed by `nextFire` (exported from `packages/store-postgres`) from the server's clock. It is in `docs/openapi.yaml`
and `webhooks.schedule.test.ts`. A bad cron or batch shows the API's `unsupported_option` message under the field; the panel only checks what it
can without a parser (blank cron, a number in range).

Changes (under `packages/panel/`):
- `src/pages/control/gateway/sendRules.ts` (new): presets, limits, `sendFieldsOf`, `sendPatchOf`, `zoneNames`, `cronLabel`, `inZone`.
- `src/pages/control/gateway/ConnectionSend.tsx` (new): the fields; named inputs and selects, each with its hint and error wired by `Field`.
- `ConnectionFields.tsx`, `ConnectionForm.tsx`, `ConnectionEdit.tsx`, `connectionPatch.ts`: carry the send fields; the create form strips `batch` for a queue.
- `connectionRules.ts`, `model.ts`, `ConnectionPreview.tsx`, `src/components/ui/nodegraph/RuleGlyph.tsx`: Schedule and Batch cards and chips with glyphs.
- `src/lib/bq/gatewayTypes.ts`, `src/lib/bq/types.ts`, `src/lib/bq.ts`, `src/lib/bqTypes.ts`, `src/lib/gatewayPayloads.ts`: types and parsers (a malformed schedule or batch reads as none).
- `src/lib/demo/fixtures.json`: the demo connection has a nightly schedule, a next send and a batch.
- Tests: `test/gateway-send-rules.test.ts` (25, new), `test/gateway-connection-send.test.tsx` (5, new), `test/gateway.helpers.tsx` and `test/gateway-connection-settings.test.tsx` updated.

Ran: `bun test packages/panel` 2169 pass / 0 fail (this includes the design-token, ui-primitives, state-colour and design-rules guards);
`bun run --cwd packages/panel build`; `bun run typecheck`; `bun run lint` (no finding in the changed files; the existing panel warnings remain);
`bun run format:check`. `web-design-guidelines` on `ConnectionSend.tsx`: added a `name` to each input and select; the placeholders stay in the
house style (no ellipsis), and the switch label is not a click target, as in the other forms' `ToggleRow`. axe 4.13 (`@axe-core/playwright`, WCAG 2 A and
AA, 2.1 AA, 2.2 AA) against `dev:stub`: 0 violations on `/events-gateway/connections/:id/settings` (schedule, zone and both batch fields shown)
and `/events-gateway/connections/new`, in dark and in light; looked at both screenshots.
Not run: `bun run test:e2e` (the full browser suite, which needs a built panel and its own Postgres runtime; task 17); the axe scan with the custom
cron input open, or with an error shown, or on a phone width; a visual comparison with a design (there is none: this reuses existing parts).
The scan used the Chromium 1248 already in the Playwright cache; Playwright 1.62.1 wants 1234, which is not installed, so nothing was downloaded.
The batch id is not shown in the panel (the delivery pages do not list it; the API returns it).
