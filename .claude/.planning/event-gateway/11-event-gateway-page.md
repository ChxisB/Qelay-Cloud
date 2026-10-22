# 11 — Panel: the Event gateway, laid out like Hookdeck's dashboard

**Status:** done · **Depends on:** 10, 05 · **Touches:** packages/panel

## Goal
`/events-gateway` (nav: Event gateway) replaces Webhooks and follows Hookdeck's screens: Connections, Events, Metrics and
Issues, with a queue's job events as the one source until D12 adds inbound sources. Hookdeck's layout and flows are the
reference; its logo, colours and wording are not copied (our own tokens and words).

## The Hookdeck screens, and what each becomes (from hookdeck.com/docs, read 2026-10-21)
| Hookdeck screen | Facts from their docs | Here |
|---|---|---|
| Connections | Each connection is a line from a source to a destination; grouped by source; click opens its settings and rules; a paused one is a yellow broken line; **+ Connection** creates one (source, destination, rules, name) | **Connections** tab: a list grouped by source ("Qelay jobs: emails"), each a row `source -> rules -> destination` with a status dot (active, paused, disabled); click opens a side panel with the rules; **+ Connection** is the current form with a destination kind. Pause and resume are the existing enable switch and the auto-pause state |
| Events | Newest first, 100 per page; statuses Pending, Failed, Successful, On hold, Cancelled; filters Status, Connection, Source, Destination, Date, HTTP response, Request text; default views Successful, Failed, Pending, Paused; a right-hand sidebar with properties, the request (headers, path, query, body) and the attempts, latest shown first; retry, bulk retry and cancel | **Events** tab: the same table and sidebar. Status chips Pending (pending and sending), Successful (delivered), Failed, On hold (its route is paused); filters Route, Status, Date, HTTP code, free text over the event name. Sidebar: properties, body sent, attempts (`DeliveryHistory`), **Retry**. **Retry all failed** shows the count and a confirm. Cancelled has no meaning here (a delivery has no cancel), so it is not shown |
| Metrics | Total, rate, successful and failed, failure ratio, average attempts per event, pending events and oldest pending, latency average and p95 and p99 and max, a time-range picker, a menu on each chart that opens Events with the same filter | **Metrics** tab: the same cards and charts over a time-range picker, scoped to one route or all; a chart's "Explore" opens Events with that filter |
| Issues | An issue opens when deliveries fail; statuses Open, Acknowledged, Resolved, Ignored; a list grouped by status with a mini histogram; the issue opens its events and a bulk retry | **Issues** tab, **read-only**: a route that auto-paused, or whose failure ratio over the last hour passes a limit, is an open issue; it lists its failed events with the bulk retry. Acknowledge, resolve and ignore need stored state: out here, recorded below |
| Sources, Requests | Own pages; a source URL; Requests log of what arrived | Not here. They arrive with the inbound-sources plan (D12), in the same tabs |
| Destinations | Own page; HTTP, CLI, Mock | Not a page: the destination is part of the connection (`http` or `queue`) |

## Steps
1. Four tabs on one page, per-path like Health and System (`/events-gateway`, `/events-gateway/events`, `/events-gateway/metrics`,
   `/events-gateway/issues`), so each deep-links. `/webhooks` and `/webhooks/:id` redirect. The capability key `webhooks` stays.
2. Connections: the list, the side panel, the create form with the destination kind (a URL, or a queue, and for a workflow the
   text "add a job that calls `startWorkflow`"). A loop shows the refusal in plain words. Send test event and Rotate secret stay
   in the side panel, with their wording.
3. Events: the table (keyset paging, 100 a page), the chips, the sidebar, Retry, Retry all failed (task 10's call).
4. Metrics: cards and two charts (events over time by status; latency) from task 10's stats call; time range and route pickers.
5. Issues: derived from the stats call and the route state; no new store.
6. Closed for a viewer's writes and origins only for URLs (existing rules). Words: route/connection, destination, event,
   attempt, source. The nav label is "Event gateway".

## Acceptance
- A connection can be created for each destination kind from the panel; a loop shows the refusal (e2e against the local stack).
- The Events table filters by status and route, and a row opens its attempts (test).
- Retry all failed shows how many it will reset and does nothing without the confirm (test).
- Metrics and Issues render an empty state with no data, and an error state when the call fails (test).
- The page is closed for a viewer's writes and shows origins only (existing rule, test).

## Verify
```bash
bun run typecheck && bun test packages/panel && bun run --cwd packages/panel test:e2e
```

## Risks / notes
- I cannot sign in to the owner's Hookdeck account (no browser tool, and credentials do not go in chat). This table is from
  the public docs. Screenshots of the screens to match closely (Connections list, an event's sidebar, Metrics) would tighten it.
- The page is large: split by tab into files under 300 lines, one data hook per tab.
- Issues without stored state is a deliberate gap against "exactly": acknowledge, resolve and ignore need a table. Record it in
  the Result and in `known-issues.md`; the owner decides whether it gets its own decision.
- The e2e suite is not run in this environment so far; say so in the Result if it still is not.

## Result

Done 2026-10-21 (panel only; no API, migration or dependency).

**What changed**
- One page at `/events-gateway` with four per-path tabs: Connections (`/events-gateway`), Events, Metrics and Issues, in
  `packages/panel/src/pages/control/gateway/` (one data hook per tab, every file under 300 lines). `GatewayPage` and
  `GatewayTabs` carry the header and the tabs. `/webhooks` and `/webhooks/:id` redirect to `/events-gateway`. The capability
  key stays `webhooks`; it now closes every `/events-gateway*` path and makes them an operator's.
- **Connections:** grouped by source ("Qelay jobs: <queue>"), each row a destination, its events, status (active, paused,
  off), counts, last, an on/off switch, an Events link, Test and Remove. The form chooses "Webhook address" or "Another
  queue"; a queue route sends `{destination:'queue', queue, target, events}` and a loop's refusal (409) shows in the form.
- **Events:** the all-routes feed, newest first, 100 a page, cursor paging; status chips; connection and time range go to the
  server (URL params, so a view deep-links), HTTP code and free text narrow the loaded page only (said under the filters);
  a row opens the event: facts, the job a queue route made (`routedJobId`), every attempt, Retry for a failed one; "On hold"
  for a pending event whose connection is off; Retry all failed (per connection, up to 500, asks first, toasts how many went back).
- **Metrics:** Successful, Failed, Failure rate, Attempts per event, Waiting now, Receiver speed (p95); events-over-time and
  receiver-speed charts; connection and time-range pickers; links to the failed or all events behind the numbers.
- **Issues:** read-only, derived from route state (`routeIssues`): paused first, then failing by alert level (50/70/90/100% of the
  way to the automatic pause), with "View failed events" and "Turn back on".
- The old `Webhooks` page and its `WebhookRow`, `WebhookForm` and `DeliveryHistory` are deleted; their tests moved.
- Text inputs use `onInput`, as every other form here does: React's `onChange` does not fire from the test DOM's `input` event.

**Ran (2026-10-21, no Docker)**
- `bun run typecheck` passes. `bun run format:check` passes (the 15 files of this task were formatted). `bun run architecture` passes
  (1626 files under 300 lines). `bun run lint` exits 0; its 108 warnings include 3 `set-state-in-effect` in the new
  `useRouteActions`, `Events` and `ConnectionForm` (the same scope-reset effect the old page had).
- `bun test packages/panel`: 1596 pass, 0 fail. New: `gateway-events` (9), `gateway-connections` (10), `gateway-metrics` (6)
  and 24 cases in `webhook-payloads`; the nav, route-contract and gating tests now name `/events-gateway`.

**Not run**
- Playwright e2e (the edited specs type-check only) and the 390/1440 clip sweeps. So the acceptance "a connection can be created
  for each destination kind (e2e against the local stack)" is covered by the panel tests with a stubbed server, not the stack.
- Hookdeck's dashboard: I could not sign in. The layout follows the public docs; their logo, colours and words are not copied.

**Gaps, on purpose** (owner decides): Issues has no acknowledge, resolve or ignore (no stored state); there is no "body sent"
(the store keeps no request body) and no p99; the Pending chip filters status `pending` only (a delivery mid-send shows under
All); Retry all failed is per connection and capped at 500; Connections is not paginated (the old page paged 15 a time); an
attempt with no latency draws as 0 in the receiver-speed chart; Rotate secret has an API but no button yet.
