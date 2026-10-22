# 01 — Connections list: table view, search, status filter, rule chips

**Status:** done · **Depends on:** none · **Touches:** packages/panel/src/pages/control/gateway, packages/panel/test

## Goal
The Connections screen can be scanned like a table, narrowed by text and by state, and each row says which rules it has.

## Steps
1. `model.ts`: `ruleChips(route)` (`Filter` when `route.filter`, `Reshaped` when `route.shape`, `Signed` for a signed http
   route), `filterRoutes(routes, { text, state })` (text matches id, queue, target and the shown destination; state is
   `routeState`). `connectionLink(id)` for `/events-gateway/connections/:id` moves to task 02, where the page exists.
2. New `ConnectionsTable.tsx`: one flat table (Source, Destination, Rules, Status, Success / Fail, Last, On, actions).
   `ConnectionRow` is reused for the actions so there is one set of buttons.
3. `Connections.tsx`: a Structured / Table switch kept in the address (`?view=table`), a search box and a Status select,
   both in the address (`q`, `state`), and "no connection matches" in words. The link from each row to the connection
   page arrives in task 02.
4. Keep every file under 300 lines (`Connections.tsx` is 130 now: move the toolbar to `ConnectionsToolbar.tsx`).

## Acceptance
- The table view lists the same connections as the structured view, with one row each and rule chips.
- Typing in the search narrows by destination text and by queue; the Status select narrows to Active, Paused or Off.
- View, search and state survive a reload (they are in the address); a bad `view` falls back to structured.
- A filter that matches nothing says so and offers to clear it; no routes at all still shows the first-connection empty state.
- Every action of the structured view (turn on or off, test, remove) works from the table, and a removed connection leaves
  both views.

## Verify
```bash
bun test packages/panel/test/gateway-model.test.ts packages/panel/test/gateway-connections-view.test.tsx packages/panel/test/gateway-connections.test.tsx
bun run typecheck
```

## Risks / notes
- No per-row 24 h count or trend: that is G1 (one stats call per row). Success / Fail stay the lifetime counts.
- Not paginated: a namespace has at most 100 routes.

## Result
Done 2026-10-21.

**Changed** (all under `packages/panel`):
- `model.ts`: `ruleChips`, `STATE_FILTERS`, `filterRoutes`.
- New `ConnectionsToolbar.tsx` (Structured / Table switch, search, State select) and `ConnectionsTable.tsx` (the flat table).
- `ConnectionRow.tsx`: a `flat` prop that adds the Source and Rules cells, so there is one set of action buttons.
- `Connections.tsx`: view, `q` and `state` live in the address (a bad `view` or `state` falls back); "No connection matches"
  with Clear filters; the empty state, the add form and the banners are unchanged.
- Tests: new `gateway-model.test.ts` and `gateway-connections-view.test.tsx` (7 tests); the existing
  `gateway-connections.test.tsx` passes unchanged.

**Ran** (local, jsdom component tests): the three test files above, 23 pass, 0 fail; `bun run typecheck` clean; oxlint on the
touched files shows only the 3 known `set-state-in-effect` warnings, none in new code; oxfmt check clean; every file under 300
lines (largest 176).

**Did not run:** Playwright, the 390/1440 clip sweeps, the full gate (that is task 06).
