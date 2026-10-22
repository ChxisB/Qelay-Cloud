# 2026-10-20 — UI patterns: read-first cards, flow graphs, teaching empty states

Requested by the owner after comparing the console with Hookdeck and n8n screenshots ("Look at the images of how neat they
are, and how the flows look... can we use any of these concepts to improve our UI in any areas?", then "Let's implement what
could be useful"). Plan: `.claude/.planning/ui-patterns/CURRENT.md`, tasks V1 to V8. Follows
[2026-10-20-ux-clarity.md](2026-10-20-ux-clarity.md); its rubric still applies.
`packages/panel` only: no engine change, no Control API change, no openapi change, no new dependency, no migration, no infra.
Nothing is committed, pushed or published.

## Changed
- **Read-first card (V1, V2).** `components/ui/ReadFirstCard.tsx` states the current value as a sentence and keeps its fields
  behind one **Edit** button (Cancel closes it); `useRevealFocus` moves focus into the first control on open and back to the
  button on close. The queue Settings cards use it: Speed limit, Jobs at the same time, Stuck job detection. Failed job handling
  stays facts only. `Button` now takes a `ref`.
- **Create cards (V3).** `components/ui/CreateCard.tsx`: Cron and Webhooks show a title and one "New schedule" or "New webhook"
  button; the form opens on press and closes after a create. While the loaded list is empty the form is shown with no button.
- **Job flows graph (V4).** `features/flows/domain/flowGraph.ts` (pure layout) and `ui/FlowGraph.tsx`: parents and children left to
  right, joined by lines; a stuck line is thicker and in the failure colour. A Graph | List switch in `FlowExplorer`; the
  arrow-key tree is the List view, unchanged. Boxes are native buttons with a full name (state, job, queue, "Holds parent",
  "Waiting on N"), selected one `aria-current`. Over 300 open jobs it says so and shows the list.
- **Workflow definition graph (V5).** `features/workflows/domain/definitionChain.ts` (pure), `ui/DefinitionGraph.tsx`,
  `ui/NodeDetail.tsx`: the nodes of a workflow as a left-to-right chain (top to bottom on a phone). A box opens its kind, steps
  and, when it can be told, what was recorded for it. While a run rolls back, a dashed line runs from the node it is at back to the first.
- **Teaching empty states (V6).** `components/ui/illustrations.tsx` (four line drawings, no text inside, `aria-hidden`); `EmptyState`
  takes `picture`. New copy on Cron, Webhooks, Job flows and the Dead letter queue.
- **V7 skipped on purpose:** `LoadingState` was already a table-shaped skeleton, announced once and pinned by a test.
- **Docs.** DESIGN-MAP R34 to R37, one panel README bullet ("Cards that say first, graphs that show").
- **Two small fixes found while looking:** "78d ago ago" on the workflow Summary and "seen 3m ago ago" on the workflow overview
  (`formatRelativeTime` already says "ago").

## Behaviour changes to sign off
- **Cron and Webhooks forms are behind a button.** The in-form "Schedule created ✓" line cannot be reached any more: the toast
  and the new row say it. When the first item is created in an empty list, focus is not moved to the new button.
- **V4 differs from the plan text in three ways.** "Holds parent" and "waiting on N" are inside the box, not on the line (the 64 px
  gap is too narrow, and text in the box is what a screen reader gets); Graph is the default above 767 px wide and a phone starts on List;
  boxes are reached with Tab, arrow keys work in the List view only.
- **Rate limit and concurrency cannot show the server's value.** The openapi has `PUT` and `DELETE` for both, no `GET`. Those cards
  say what was set from this page in this session, otherwise "the server does not report it". A `GET` is a new public route and a
  human gate: **not built, your decision.**
- **A failed or rolled-back workflow run gets no marks and no return line on its Definition tab.** The server gives `currentNodeIndex`
  as a count for a failed run, not a place, so any mark would be a guess. Only a live rollback draws the line. The Summary and
  Steps tabs still show the rollback.
- **Recorded steps are matched to nodes by a unique name only.** A step in a loop, or two nodes with the same step name, is shown as
  "used more than once" with a pointer to the Steps tab. Only the output is shown: a recorded step carries no input.
- **No button on the empty Cron and Webhooks states** (the form is already open above the empty list). Only `/cron` and `/dlq` got the new
  empty state; `pages/Cron.tsx`, `pages/Dlq.tsx` and the `/dlq-control` alias keep their copy, as tests pin it.
- **Pinned tests and e2e labels changed on purpose, never loosened:** `server-action-pages-03`, `mutation-action-guards`,
  `cron-add-clone-audit`, `queue-control-audit-05` and `-06`, `flow-page`, and in e2e `walkthrough` ("Nothing has failed"),
  `dashboard`, `webhooks` (reopens the form to check the secret is empty), `flows` (checks the marked node on the Graph, then the row in
  the List), `walkthrough.drills`, `workflows` (a Definition-tab check in the stuck-rollback test). The page tests that read the flow
  tree run on a 500 px screen, as a phone does.

## Checked
Scratch Postgres 18 on 127.0.0.1:55442 with `QCLOUD_REQUIRE_DB=1`, Chromium only, no real cloud resource touched.
- **Gate.** typecheck, lint (116 warnings, 0 errors), format check and architecture are clean. `bun test`: 5220 pass, 252 skip, 1 fail
  (`test/docs/release.test.ts:21`: the licence file still carries the upstream copyright line; known, the owner's decision). The
  plan-throughput flake (`read.plans.aux.test.ts`) passed this run. The two "ago" edits landed after the gate began; typecheck, lint,
  format check and the 49 workflow panel tests were run again after them.
- **e2e with axe: 35 of 35 in one run.** The first full run had 2 failures, both from my own changes (the Graph is the default view, and the
  webhook form closes after a create); the two specs were updated, then the whole suite was re-run clean.
- **Headless Chromium, 43 routes at 390 and 1440 wide:** no clipped select, button or table head. The 172 hits are the two sr-only
  elements ("Skip to content", "Active node"). I looked at the Job flows graph, the Definition tab for a running, a waiting and a
  compensation-stuck run, the queue Settings cards and Cron at both widths.
- **New tests:** `read-first-card`, `create-card`, `limit-sentences`, `flow-graph`, `flow-graph-page`, `definition-chain`,
  `workflow-definition-graph`, `empty-states`.

## Owed or not run
- Firefox and WebKit e2e, a pixel diff against the boards, and a try-out with a real first-time user.
- `bun run test:model` (no queue semantics changed). No Pub/Sub or ElasticMQ suite (no transport code changed).
- Still open from before: the licence-line test; `DlqProTable.tsx` `text-xs` cells and the DLQ control table's sideways scroll at 1280 wide
  and below; "Dead Letter" in `MetricsStatusPanels.tsx`; the Alerts copy that says "hosted qelay Cloud"; the `read.plans.aux` plan test, which is flaky.
- Not drawn, on purpose: drag-and-drop editing, zoom and pan, Hookdeck's sidebar upsell and nav grouping, a per-row sparkline (the list
  endpoints return no 24-hour series).
- A scratch Playwright config outside `packages/panel` loads the specs as CommonJS; keep it in the package and delete it after (it was deleted).
- Running now and yours to stop: the demo server (`vite`, port 5273) and the scratch Postgres on 55442.
