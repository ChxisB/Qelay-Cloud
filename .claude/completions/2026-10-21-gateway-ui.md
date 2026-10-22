# Event gateway panel, laid out like Hookdeck (tasks 01 to 06 done)

Plan: `.claude/.planning/gateway-ui/CURRENT.md`. Each task's Result has the detail; this is the hand-off view.
Panel only: **no migration, no new openapi route, no dependency, no `infra/`.** The one new client call is
`rotateWebhookSecret`, for a route the contract already has. Nothing is committed.

## Done

| Task | What |
|---|---|
| 01 | Connections: a Structured / Table toggle, name filter, status filter, rule chips on each row. |
| 02 | A connection page at `/events-gateway/connections/:id` with Overview, Metrics and Settings tabs, Pause at the top right and a details rail. |
| 03 | Settings tab: the rules as an ordered pipeline (read-only), the signing secret (Create or Rotate, shown once), Pause and Remove as separate sections. |
| 04 | Events: a timeline strip over the list (one stats read per filter change, none from the minute poll), Refresh, and saved views kept in this browser. |
| 05 | New connection is a page, `/events-gateway/connections/new`, with four steps: Source, Destination, Rules, Save. A refusal stays at its step with what was typed kept; saving opens the connection. |
| 06 | `docs/event-gateway.md` rewritten to match; the gate; a hand review. It found one bug, fixed (below). |

## Bug found and fixed in task 06

When a create has no secret and the deployment has a signing key, the store makes one and returns it once in `data.secret`.
The create page dropped it, so a signed connection was made whose secret nobody saw. A failing test came first
(`gateway-create-secret.test.tsx`). Now the page shows the secret with a copy button and waits for **Open connection**; it is
held in component state only. `SecretBanner.tsx` is shared with the Settings tab.

## Changed files

- New, `packages/panel/src/pages/control/gateway/` (untracked as a folder, with the earlier event-gateway pages): connection
  list, connection page and tabs, `EventTimeline.tsx`, `SavedViews.tsx`, `useSavedViews.ts`, `useGatewayStats.ts`,
  `ConnectionForm.tsx`, `CreateConnection.tsx`, `SecretBanner.tsx`, `model.ts`, `MetricsParts.tsx`.
- Edited: `packages/panel/src/App.tsx` (lazy `CreateConnection` route, listed before `:id`),
  `components/layout/pageTitle.ts`.
- New tests in `packages/panel/test/`: `gateway-connections`, `-connections-view`, `-connection-page`, `-connection-settings`,
  `-events`, `-events-timeline`, `-metrics`, `-model`, `-create`, `-create-secret`, `gateway-create.helpers.tsx`,
  `gateway.helpers.tsx`, `nav-groups.test.tsx`. Edited: `app-routes-complete`, `nav-shell`,
  `server-action-pages-03`. `nav-groups.test.tsx` was split out of `nav-shell.test.tsx` to keep it under 300 lines.
- `docs/event-gateway.md` (new, untracked), and the task files under `.claude/.planning/gateway-ui/`.

## Checked

Local Postgres 18 (Homebrew, port 55442), `QCLOUD_REQUIRE_DB=1`, on the final tree:

- `typecheck`, `format:check`, `architecture`, `docs:check` (7 documented blocks run): pass. `lint`: exit 0, warnings only; three
  `set-state-in-effect` warnings are in the new code, on scope-reset effects (`useRouteActions.ts`, `Events.tsx`,
  `ConnectionForm.tsx`).
- `bun test`: **5387 pass, 252 skip, 1 fail** (686 s). The failure is `package metadata > every package is MIT ...`. It fails at
  HEAD: commit `4103cee` removed the upstream copyright line from `LICENSE` and the test still wants it. The owner's call; not
  touched here.
- `bun test packages/panel`: 1671 pass, 0 fail.
- An earlier full run, started before the secret fix, had 4 fail and 1 error that did not recur. They were not identified
  one by one; the game-day `database.test.ts` and `read.plans.aux.test.ts` have flaked before.
- Mutation checks in tasks 02 to 05 proved the key behaviours (strip polling, step routing, id extraction, route order).
- Hand review of the secret on screen: state only; tests assert it is in neither storage nor the toast store.

## Not run

- **Playwright e2e and the 390 / 1440 width sweeps.** `e2e/webhooks.e2e.ts` still drives the old UI (`/webhooks`, "New webhook",
  "Add webhook") and was stale before task 05. It needs rewriting for the connection and create pages.
- Component tests render `ConnectionPage` and `CreateConnection` in their own `Routes`, so a wrong prop in `App.tsx`
  would show only in e2e.
- `test:model` (no queue-semantics change). The 252 skipped suites (Docker, PgBouncer, TLS, Pub/Sub, ElasticMQ).
- The security-review skill (no `origin/HEAD`); the review was by hand.

## Known limits

- Issues is read-only. The HTTP code and text filters on Events apply to the loaded page only. `since` uses the browser clock.
- Connections is not paginated. A timeline bar is not a link. The stats-read cost is unmeasured and task 04 adds one stats
  read per Events filter change.
- The Settings tab's rate, retry and pause words are the documented defaults, not read from the route.

## Needs the owner

- **G1 to G5**, each a sign-off (`docs/event-gateway.md`, "Not built"):
  - G1 grouped stats (`GET /webhooks/stats?groupBy=webhook`), a new openapi parameter.
  - G2 issue state: a migration, routes and audit rows.
  - G3 connection name, description and editable rules (`PATCH /webhooks/{id}`): a migration and a route.
  - G4 delay, dedupe and transform rules, and Disable-and-ignore: new sender semantics.
  - G5 reusable sources and destinations: a model change. Inbound sources stay D12.
- **An inconsistency to settle:** openapi (`setWebhookEnabled`) says a hand-disabled webhook gets no new deliveries;
  `docs/webhooks.md` says a paused one still collects them.
- The `LICENSE` test (above).
- The Hookdeck screenshots in the session scratchpad (`.../scratchpad/hookdeck/shots/`) show the owner's real names; delete them.
