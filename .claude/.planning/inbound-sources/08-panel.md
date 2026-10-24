# 08 — Panel: Sources and Requests tabs, a connection form without events

**Status:** done · **Depends on:** 05, 06 · **Touches:** packages/panel
**Design:** not needed, reuses the Destinations page and the Events table

## Goal
The Event gateway shows Sources and Requests, and a connection is "a source, rules, a destination", with no event buttons.

## Steps
1. Remove "Events to send" and the queue picker from `ConnectionFields.tsx`; add a Source picker. The Filter, Shape and Dedupe
   fields and their hints use request paths (`body.id`, `headers.x-event`); a sample document in the preview.
2. Sources tab beside Destinations: list with URL, verification and last request; create form (secret and URL shown once);
   rotate; enable and disable.
3. Requests tab beside Events: the log with source and status filters, a sidebar (headers, query, body, the events it made),
   Replay.
4. A route that is off because its source was removed shows "Needs a source" and a Source picker.
5. Demo data in `src/lib/demo` and the stub server follow; panel tests are edited to assert the new copy.

## Acceptance
- The words "Events to send" and `job.` appear nowhere in `packages/panel/src` (grep).
- A connection can be created from a source to an HTTP destination in the stub (test).
- The panel guards (`design-tokens`, `ui-primitives-guard`, `state-colours`, ...) pass.
- `bun run --cwd packages/panel build` passes; `bun run test:e2e` and the axe scan run on the new routes, or are named as not run.

## Verify
```bash
bun run --cwd packages/panel build && bun test packages/panel && bun run test:e2e
```

## Result

Done 2026-10-23. The connection form has no "Events to send" and no queue picker; it has a Source picker. The gateway has two
new tabs, Sources and Requests, and a connection with no source says so and lets an operator pick one.

**What changed (`packages/panel`)**
- Client and parsers: `lib/bq/gatewayTypes.ts`, `lib/bq/resourceApi.ts`, `lib/sourcePayloads.ts` (sources, a request, a page of
  requests, a replay), `lib/bq.ts`, `lib/dashboardPayloads.ts`.
- Sources (`pages/control/gateway/`): `Sources`, `SourceCard`, `SourceForm`, `SourceIssuedBanner`, `useSourceActions`,
  `sourceModel`. The address (`/s/<token>`) and the secret are shown once, in page state, until Done; never in the address bar,
  storage or a toast.
- Requests: `Requests` (status chips and a source filter kept in the address, Newer/Older), `RequestsTable`, `RequestDetail`
  (headers, query, body, the events it made, Replay behind a confirm; a viewer gets no body).
- Connections: `SourcePicker` in `ConnectionForm`, a "Source: <id>" line in the preview, and `NeedsSource` on the connection page
  (`route.source === null`: the route is off; the operator picks a source, then enables it).
- Wiring: `navConfig` (seven gateway tabs), `pageTitle`, `App` (lazy routes `/events-gateway/sources` and `/requests`).
- Demo mode: `lib/demo/sources.ts` and `demoRequestDeliveries`, two roots (`sources`, `requests`) in `lib/demo/api.ts`.
- Tests: `gateway-sources`, `gateway-requests`, `gateway-needs-source`, `gateway-source-model`, `source-payloads`,
  `demo-sources`; the create, edit, connection-page, route-list and demo-root tests were edited to assert the new behaviour.

**What ran, against what**
- `bun test packages/panel` from the repo root: 2139 pass, 0 fail, 299 files (after the last edit). The panel guards
  (`design-tokens`, `ui-primitives-guard`, `state-colours`, `accent-split-guard`, `brand-assets`, `design-rules-guard`, `fonts`)
  are part of it.
- Root `bun run typecheck` and `packages/panel` typecheck: pass. `bun run lint`: exit 0, warnings only (the existing
  `set-state-in-effect` kind). `bun run format:check`: clean. `bun run architecture`: pass.
  `bun run --cwd packages/panel build`: pass.
- Acceptance greps: "Events to send" and `job.` appear nowhere in `packages/panel/src`. A connection is created from a source
  to an HTTP destination in `gateway-create.test.tsx`, against the stub fetch.
- By eye, demo mode on the Vite dev server, 1280x900, dark theme: Sources and Requests render the demo data (two sources, one
  rejected request with its cause). Light theme, a phone width, the connection page and the detail pane were not looked at.
- `web-design-guidelines` on the nine new files: two findings, both fixed. The source card's buttons all read alike
  (now "Turn off Shop checkout" and so on, each still containing its visible word), and the request button's name did not contain
  its visible text (now "Open request POST 4822"). Left as they are: the guideline asks for Title Case, the panel's rule is
  sentence case; a page of 100 rows is not virtualised; the Newer/Older position is not in the address.

**Not run**
- `bun run test:e2e` and the axe scan on the new routes: the Playwright browser build for this version is not installed (it is a
  download into the user's cache, not done). `e2e/webhooks.e2e.ts` was written for the pre-gateway page and is stale against
  the redesign; that was true before this task and is not fixed here.
- `accesslint:accessibility-scan` returned only page-level findings on `<html>` for both routes (no main landmark, no h1,
  no bypass), which is what an unrendered shell gives; it is not counted as a result. `accessibility-inspect` (keyboard and
  focus on the new form and the detail pane) was not run.
- Firefox and WebKit: not run.

**Deviations and limits**
- The Control API does not know the ingest origin, so the panel shows only `/s/<token>` and says to post to the ingest address
  followed by it. A source row has no "last request" (it would be a new field on the wire); its Requests link filters the log.
- No source rename, and no sheet for a request: it opens beside the list on a wide window and under it on a narrow one.
- A connection's labels still read `Source: <id>` (`sourceLabel` in `model.ts`), not the source's name.
- The repair for a connection with no source is on the connection page only, not in the list.
- Design pass: not needed (reuses the Destinations page, the Events table and the connection form). No new colour, font or
  dependency.
