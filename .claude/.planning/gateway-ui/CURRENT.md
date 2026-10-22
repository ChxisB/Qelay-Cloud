# Event gateway, Hookdeck-style screens

Requested by the owner on 2026-10-21: "implement hookdeck layout and functionality into our platform for event gateway /
webhooks. Let's make our platform slick." The reference is the owner's own Hookdeck dashboard, looked at read-only on
2026-10-21 (layout and behaviour only: no logo, colours, wording or project names are copied). Builds on the closed plan
[event-gateway](../event-gateway/CURRENT.md); D11 is unchanged.

## Goal
The four Event gateway screens read and behave like a connection-centred gateway console: a list you can scan and filter,
one page per connection, an events view with a timeline and saved views, and a guided create page. All on the Control
API as it is.

## What Hookdeck does that we mirror
| Hookdeck | Here |
|---|---|
| Connections: Structured / Table toggle, name filter, Status filter, rule chips | task 01 |
| A connection page: breadcrumb, Overview / Metrics / Settings, Pause at the top right, details rail, its own charts | tasks 02, 03 |
| Rules as an ordered pipeline; Pause and Delete as separate sections; signing secret | task 03 |
| Events: timeline strip over the list, Refresh, Save view | task 04 |
| Create connection as one guided page: source, destination, rules, save | task 05 |

## Scope
- **In:** `packages/panel` (pages, model, one API client call to an existing route, tests), `docs/event-gateway.md`.
- **Out, and why (each is a human gate, recorded as a proposal, not built):**
  - **G1 Grouped stats** (`GET /webhooks/stats?groupBy=webhook`): a 24 h count and trend on every list row. Today that is one
    stats call per row; the stats read's cost is unmeasured ([limits.md](../../../docs/limits.md)). New openapi parameter.
  - **G2 Issue state** (acknowledge, resolve, ignore, with Open / Acknowledged / Resolved / Ignored tabs): a migration, new
    routes, audit rows.
  - **G3 Connection name and description, and editing rules** (`PATCH /webhooks/{id}`): a migration and a new route. Until
    then the Settings tab shows rules and cannot change them; a change is remove and add.
  - **G4 Delay, dedupe, transform rules** and **Disable-and-ignore** (a second off state): new semantics in the sender.
  - **G5 Reusable sources and destinations**: a model change (a route embeds its destination today). Inbound sources are D12.

## Touches
Panel only. **No migration, no new openapi route, no dependency, no `infra/`.** The one new client call is
`rotateWebhookSecret` for `POST /webhooks/{id}/rotate-secret`, which the contract already has.

## Design impact
Fits DESIGN.md section 6 (D11). No decision changes. The panel stays read/write through the Control API only.

## Risks
- The working tree is large and uncommitted (branch `feat/review-2026-10-19`); this plan commits nothing.
- A new page path (`/events-gateway/connections/:id`) must keep the sidebar item highlighted and the capability gate
  (`/events-gateway`) closed for a deployment without webhooks. Task 02 has a test for both.
- Rotating a secret puts a secret on screen once. It lives in component state only: never in the address, storage or a
  toast, and it is cleared when the page is left.
- Saved views live in `localStorage` of one browser: they are a convenience, not shared state, and the page works when
  storage throws.
- No Playwright run: the e2e and 390/1440 clip sweeps need the full stack. Component tests only, as for task 13.

## Status
| # | Mini-task | Depends on | Status |
|---|-----------|-----------|--------|
| 01 | [Connections list: table view, search, status filter, rule chips](01-connections-list.md) | | done |
| 02 | [Connection page: Overview and Metrics tabs, Pause](02-connection-page.md) | 01 | done |
| 03 | [Connection Settings tab: rules, rotate secret, danger section](03-connection-settings.md) | 02 | done |
| 04 | [Events: timeline strip, Refresh, saved views](04-events-timeline.md) | | done |
| 05 | [Create connection as a guided page](05-create-page.md) | 02 | done |
| 06 | [Docs, gate and hand-off](06-docs-and-handoff.md) | 01–05 | done |
