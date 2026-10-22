# Motion redesign: a connected, moving console

Requested by the owner on 2026-10-21: "redesigning the Qelay platform, we want nice motion and animation; clean and clear
UI/UX ... slick UI like the screenshot showcase how things are connected. This is for every screen as this is more for the
events gateway / webhook gateway. But let's update the entire platform UI/UX making it user friendly, neat with nice motion
and animation. Go through each screen, models etc."

The four screenshots are the owner's own Hookdeck dashboard (Connections, Structured view). Layout and behaviour only: no
logo, colour, wording or sample names ("heatable-…") are copied (operating rule 5). Builds on
[console-redesign](../console-redesign/CURRENT.md) (the Carebell look), [ui-patterns](../ui-patterns/CURRENT.md) (read-first
cards, flow graphs), [gateway-ui](../gateway-ui/CURRENT.md) and [gateway-features](../gateway-features/CURRENT.md).

## Goal
1. **One motion system** on every screen: a few shared durations and easings, a handful of patterns (arrive, leave, change,
   connect), all of it off under `prefers-reduced-motion`. Motion says where something came from, what changed, or what is
   connected to what. It never decorates.
2. **A connected language** for the places where things really are connected: a node (a thing), a line (the way between
   things), a pill on the line (the connection), rule glyphs on the line, and a hover card. The Event gateway's Connections
   screen becomes the line diagram in the screenshots (source, connection, destination, 24-hour figure). The same pieces
   show a queue's job lifecycle, a cron's schedule and its queue, an event and its attempts, a destination and the
   connections that use it, and the health chain.

## What is true today (Phase 0 findings)
- `Connections` defaults to a view called **Structured**, but it is one card per source holding a table
  (`pages/control/gateway/Connections.tsx`, `ConnectionRow.tsx`). The line diagram of the screenshots does not exist. The pieces
  for it do: `components/ui/nodegraph/` (`NodeTile`, `Connector`), `ruleCards()` and `ruleChips()` in `gateway/`, the 24-hour
  `useGroupStats` read, and `RouteStatePill`.
- Motion today: a pulse skeleton, a spinner, one ping dot, a benchmark bar, 58 `transition-*` uses and one global
  `prefers-reduced-motion` reset (`src/index.css`). No route transition, no exit animation (overlays unmount), no draw-in.
- The panel only polls (`usePolledData`). It has no event stream on screen, so a line cannot show live traffic. It can show
  that a count or a last-triggered time **changed since the last read**, and that is all a pulse may mean.
- 146 page files, 65 component files, about 56 routes, 14 nav items in four groups under Home (`navConfig.ts`).
- The working tree is large and uncommitted (560 paths on `feat/review-2026-10-19`, including the deleted classic pages). This
  plan commits nothing.

## Scope
**In** (`packages/panel` only)
- Motion tokens (durations, easings) and the reduced-motion rule, in `tokens.css` and `index.css`.
- Motion primitives: arrive (fade and rise), leave (faster than arrive), stagger (capped), count change, change flash, route
  transition, overlay presence, line draw and one-shot pulse.
- Connected-language primitives in `components/ui/nodegraph/`, then the screens that use them (below).
- Every page group, the shell, the overlays, the states and the auth screens: micro-interactions and the connected pieces
  where a real relation exists.
- Tests that pin the old markup or copy are edited in the same task, never loosened. Guards for the new rules.

**Out**
- New routes, API calls, roles or data. A control for something `shared/flowOperationPolicy.ts` gates off, or that needs
  data the panel does not have, is left out and listed as a deviation.
- Editing graphs (drag and drop), zoom and pan. Graphs stay read-only.
- Continuous or decorative animation: no looping backgrounds, no idle bounce, no fake traffic.
- New colours. Any value that needs a token pair goes to the owner.
- A prefill of the Create page's source from the address (the "+" on the line in the screenshot). It is new behaviour.
- `../qelay`, `../qelay-control-panel`, the Control API, migrations, `infra/`.

## Touches
`packages/panel` (`src/tokens.css`, `src/index.css`, `src/components/ui`, `components/layout`, `pages`, `features`, `test`,
`e2e`), the panel README's "Look and feel", `docs/PORTING.md` (one row under "Panel"), DESIGN-MAP. No migration, no openapi
change, no infra, no store or transport interface, no auth, **no new dependency**.

## Design impact
Fits DESIGN.md: nothing below the panel changes. Fits D8 (the panel diverges from upstream on purpose). It changes how pages
look and move, not what they do.

How motion is built, with no package: CSS transitions and keyframes; `@starting-style` with `transition-behavior:
allow-discrete` for enter and exit of popovers and dialogs; React Router's `viewTransition` on links and navigation for the
route change (the View Transitions API, a progressive enhancement: where a browser lacks it the page just changes); an SVG
dash for the line draw and the pulse. A motion library (`motion`, formerly `framer-motion`) would be a human gate. It is not
needed for anything in this plan, and it is not proposed.

## Design
**Claude Design:** https://claude.ai/artifact/TMMbZ97jDRzvSpWiFVKRuG (canvas "Design", version `1792625519-cabd`, read
2026-10-22; the same content as the earlier canvas 38mjPuVmfty4i3nmdeDkPo, version 21, which it replaces). 16 boards: Motion, Connected language, Shell and overlays, Connections, Connection states, Connection page,
Gateway events, Gateway more, Home, Work, Automation, Monitor, Health, System, System more, States. Private until the owner
shares it from the page's Share menu. Board to page to task, every numbered deviation and the owner's open questions are in
[DESIGN-MAP.md](DESIGN-MAP.md).

Skills used: `frontend-design`, `bencium-controlled-ux-designer`, `composition-patterns`, `ui-ux-pro-max:ui-ux-pro-max` (its
generic palette and font output was not used: the Carebell tokens and Plus Jakarta Sans rule, per the repo rules).

Settled before the canvas (from Carebell's Motion section and the panel's own rules): press 160 ms, hover 240 ms, enter 300 ms
as the ceiling for anything a person waits on, `settle` as the default easing and `pop` for small switches only; animate
`transform` and `opacity`; everything inside `prefers-reduced-motion: no-preference`.

Approved on 2026-10-22 with the design (non-colour tokens, so no light/dark pair; full table in DESIGN-MAP.md):
`--dur-enter` 300 ms, `--dur-exit` 180 ms (a leave is faster than an arrive), `--ease-exit`, `--dur-stagger` 40 ms with a cap of
8 items, `--dur-draw` 600 ms, `--dur-flow` 900 ms for the one-shot pulse along a line.

Sample content: every name, queue, address, figure, time and error text on the canvas is sample. Labels (nav, tabs, states,
buttons, rule names, count words) are the panel's own words. Where a board adds wording (Home H1, W1, W2, A2, M3, M6, SY1, SX1,
G7) DESIGN-MAP.md lists it for the owner's word.

How it was checked: a Node script audited every board and called every handler. Nothing was rendered or screenshotted, so look
and motion timing are not seen by eye.

Approved by the owner on 2026-10-22 ("yes"): the design, the tokens, S2 (the in-page confirm replaces `window.confirm` and
changes behaviour), A5, A6 and SX2 (three actions kept as today although they sit near the gated ones), and the new wording above.

## Risks
- **Scale.** About 56 routes. Page tasks stay a handful of files each, files stay under 300 lines, and motion is added
  through shared primitives so a page rarely needs its own.
- **Reduced motion and tests.** `happy-dom` has no animations: tests assert the end state and the `data-` or class hook, not
  timing. A guard fails on a raw duration or `@keyframes` outside the token layer.
- **Exit animation on unmount.** The overlays unmount today. Presence needs a small hook and a test for focus return
  (`useGlobalModalStore`'s `mayRestoreModalFocus`) so a leaving dialog never traps or loses focus.
- **View Transitions and focus.** A route transition must not move focus or break `useRouteScrollReset`.
- **Perf.** Animate `transform` and `opacity` only, except the SVG dash. A list of 1000 rows does not stagger beyond 8.
- **Pulse honesty.** A pulse fires only when a polled value changed. Idle lines are still. No claim of "live" without the poll.
- **No Playwright or visual diff.** The e2e and the 390 and 1440 clip sweeps need the full stack, and there is no visual diff
  harness (said in each Result). Checks of look and motion are by eye on `dev:stub`.
- Many tests pin markup: Connections tests change on purpose in the Connections task.

## Human gates in this plan
| Gate | Where | State |
|------|-------|-------|
| The design (Claude Design) | Phase 1 | approved by the owner, "yes", 2026-10-22; the new canvas link holds the same content |
| New motion tokens (non-colour) | task 01 | approved 2026-10-22 |
| In-page confirm instead of `window.confirm` (S2), and A5, A6, SX2 kept as today | tasks 04b, 06 to 13c | approved 2026-10-22 |
| A motion library | none | not needed, not proposed |
| Any API call, route, auth, role, migration, `infra/` | none | not hit |
| Push, publish, version bump | none | never in this plan |

## Status
Bottom up: tokens, primitives, shell and overlays, then pages. The canvas has 16 boards; the first proposal's task 04 became
04a and 04b, 08 became 08a and 08b, 09 became 09a and 09b, 10 became 10a to 10c, 11 became 11a and 11b, 12 became 12a and 12b, and 13 became 13a to
13d (DESIGN-MAP.md). Work them in order. A task is done when its Acceptance is true and its Verify was run; fill in its Result.

| # | Mini-task | Depends on | Status |
|---|-----------|-----------|--------|
| 01 | [Motion tokens, reduced-motion rule, motion guard](01-motion-tokens.md) | none | done |
| 02 | [Motion primitives (utilities, usePresence, useChangeFlash)](02-motion-primitives.md) | 01 | done |
| 03 | [Connected language (node, line, pill, rule glyphs, hover card)](03-connected-language.md) | 01, 02 | done |
| 04a | [Shell (sidebar highlight, connection badge, route transition, phone menu)](04a-shell.md) | 02 | done |
| 04b | [Overlays and the in-page confirm](04b-overlays.md) | 02, 04a | done |
| 05 | [Feedback and data display](05-feedback-data.md) | 02 | done |
| 06 | [Event gateway: Connections line diagram](06-gateway-connections.md) | 03, 05 | done |
| 07 | [Event gateway: connection page and Create](07-connection-page.md) | 06 | done |
| 08a | [Event gateway: Events, event detail, Issues](08a-gateway-events.md) | 06 | done |
| 08b | [Event gateway: Destinations and Metrics](08b-gateway-destinations-metrics.md) | 06 | done |
| 09a | [Home: the Job flow](09-home.md) | 03, 05 | done |
| 09b | [Home: glyphs, attention, activity, queue health](09b-home-states.md) | 09a | done |
| 10a | [Queues and the queue page](10a-queues.md) | 03, 04b, 05 | done |
| 10b | [Jobs, job inspector and their confirms](10b-jobs.md) | 03, 04b, 05 | done |
| 10c | [DLQ and Bulk add](10c-dlq-bulk-add.md) | 10b | done |
| 11a | [Cron](11a-cron.md) | 03, 04b, 05 | done |
| 11b | [Flows and workflow runs](11b-flows-workflows.md) | 03, 05 | done |
| 12a | [Monitor: Metrics and Logs](12a-monitor-metrics-logs.md) | 02, 05 | done |
| 12b | [Monitor: Workers and Alerts](12b-monitor-workers-alerts.md) | 03, 04b, 05 | done |
| 13a | [Health](13a-health.md) | 03, 05 | done |
| 13b | [System](13b-system.md) | 03, 04b, 05 | done |
| 13c | [Benchmark, Fleet and Settings](13c-benchmark-fleet-settings.md) | 03, 04b, 05 | done |
| 13d | [Sign in and page states](13d-auth-and-page-states.md) | 04b, 05 | done |
| 14 | [Guards, docs and hand-off notes](14-guards-docs.md) | 06 to 13d | done |
| 15 | [Verify and review](15-verify-review.md) | all | done |

The 27 `window.confirm` call sites move one task at a time (21 are left after 08b, all in the tasks below): 04b 1, 06 1, 07 2, 08a 1, 08b 1, 10a 2, 10b 4, 10c 1, 11a 2, 12b 2, 13b 6,
13c 4. Task 14 added the guard (`native-dialog-guard.test.ts`); none is left.
