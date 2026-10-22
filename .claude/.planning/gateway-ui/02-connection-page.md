# 02 — Connection page: Overview and Metrics tabs, Pause

**Status:** done · **Depends on:** 01 · **Touches:** packages/panel/src (App.tsx, navConfig, pageTitle, gateway/), packages/panel/test

## Goal
Each connection has a page of its own, reached from the list, with its details, its numbers and a Pause / Resume button.

## Steps
1. Routes `/events-gateway/connections/:id` (Overview) and `…/:id/metrics`, each a real path (`…/:id/settings` joins in task 03).
   Add `/events-gateway/connections/*` to the Event gateway item's `also` in `navConfig.ts` so the sidebar stays current,
   and a `pageTitle` entry.
2. New `ConnectionPage.tsx` (frame: breadcrumb "Connections / <destination>", tab bar through `LinkTabs`, Pause or Resume
   in the header). The connection is found in the list read (`bq.webhooks()`), so there is no new call; an id that is not
   there says "This connection no longer exists" with a link back.
3. `ConnectionOverview.tsx`: a details rail (state, source, destination kind and target, events sent, signed or not,
   created, last triggered, id with a copy button) and the 24 h numbers and chart of the existing Metrics screen for this
   one route. Reuse the Metrics pieces; do not copy them (split `Metrics.tsx` so the cards are a component taking a route).
4. `…/metrics` is the Metrics screen with its time range, for this route only (the connection select is hidden).
5. Pause and Resume use `useRouteActions().toggleEnabled`, optimistic as on the list. Send test event and "View events"
   (`eventsLink({ route })`) sit beside it.

## Acceptance
- The list's destination link opens the page; its breadcrumb goes back.
- Pause turns the connection off and the state pill and button follow; Resume reverses it; a failure says so and the state
  returns to what the server has.
- An unknown id shows the "no longer exists" state, not an empty page.
- The sidebar item is current on every `/events-gateway/connections/…` path, and a deployment without webhooks does not
  serve them (the capability gate covers the prefix).
- The Metrics tab sends `webhook=<id>` to the stats read and has no connection select.

## Verify
```bash
bun test packages/panel/test/gateway-connection-page.test.tsx packages/panel/test/gateway-metrics.test.tsx
bun test packages/panel/test/nav-shell.test.tsx packages/panel/test/capabilities.test.ts packages/panel/test/app-routes-complete.test.tsx
bun run typecheck
```

## Risks / notes
- One stats read per open page per poll, the same as the Metrics screen today.
- A viewer cannot write: the buttons follow the same access as the list (the whole page is operator-only already).

## Result
Done 2026-10-21.

**Changed** (all under `packages/panel`):
- New `ConnectionPage.tsx` (header with source and destination, state pill, Pause / Resume, Send test event, View events; tab bar
  through `LinkTabs`; "no longer exists" state; a warning banner with the reason when the store paused it),
  `ConnectionOverview.tsx` (details list, 24 h numbers and chart), `ConnectionMetrics.tsx` (range select, same report),
  `RouteStatePill.tsx` (shared with the list row).
- `Metrics.tsx` split: `MetricsParts.tsx` (`StatsFrame`, `StatCards`, `EventsChart`, `MetricsReport`, `RangeSelect`) and
  `useGatewayStats.ts` (`useRange`, `useGatewayStats`). The Metrics screen behaves as before.
- `useRouteActions` now also owns Send test event (`test`, `testing`), moved out of `Connections.tsx`.
- `model.ts` `connectionLink`; list rows link their destination to the page.
- `App.tsx` two routes; `navConfig.ts` `also` gains `/events-gateway/connections/*`; `pageTitle.ts` titles both paths.
- Tests: new `gateway-connection-page.test.tsx` (10); added rows to `capabilities.test.ts` (the gate covers the prefix),
  `nav-shell.test.tsx` (item current, crumbs), `frontend-a11y-fixes.test.ts` (titles) and `app-routes-complete.test.tsx`.

**Ran** (local, jsdom component tests): all of `packages/panel` 1633 pass, 0 fail; `bun run typecheck` clean; `bun run lint`
exit 0 with only the existing warnings; `bun run format:check` clean; every gateway file under 300 lines (largest 240).

**Did not run:** Playwright, the 390/1440 clip sweeps, the full gate (task 06).

**Not covered:** the page's two routes are asserted against `App.tsx` by the route-contract test, but the tests render
`ConnectionPage` in their own `Routes`, so a wrong prop in `App.tsx` (`tab="metrics"` on the wrong path) would not be caught
until an e2e run.
