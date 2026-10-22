# UI patterns: read-first cards, flow graphs, teaching empty states

Requested by the owner after comparing the console with Hookdeck and n8n screenshots ("Look at the images of how neat they
are, and how the flows look... can we use any of these concepts to improve our UI?" then "Let's implement what could be
useful"). Follows [ux-clarity](../ux-clarity/CURRENT.md); its rubric still applies.

## Goal
Borrow three ideas, not the brands: (1) a card says its current value as a sentence and hides its fields behind **Edit**,
(2) a job flow and a workflow definition are drawn as a left-to-right graph, (3) an empty page teaches what the feature is.

## Scope in
- `packages/panel` only. A shared read-first card; the queue Settings cards; Cron and Webhooks create forms if they fit;
  a read-only graph for Job flows (Graph | List switch, the list stays) and for the workflow definition; teaching empty
  states for Cron, Webhooks, Job flows and Dead letter queue; a shared list skeleton if time is left.
- Hand-rolled: HTML buttons for nodes, one SVG layer for the lines. **No new dependency.**

## Scope out
- n8n's drag and drop editing (the graph is read-only), zoom and pan.
- Hookdeck's sidebar upsell card, its branding, and its "Configure / Monitor / Inspect" nav grouping (the nav labels are the design's).
- A per-row sparkline: the list endpoints return no 24-hour series, so it would cost one request per row. Not done.
- A `GET` for a queue's current rate limit and concurrency (see Risks). Not done without the owner.

## Touches
panel (`components/ui`, `pages/control/queue`, `pages/control/cron`, `pages/control/webhooks`, `features/flows`,
`features/workflows`), docs (DESIGN-MAP R34+, panel README). No migration, no openapi change, no infra, no auth.

## Design impact
Fits DESIGN.md: nothing below the panel changes and no payload key changes. Visual calls not in the boards go in
DESIGN-MAP as R34 and later.

## Risks
- **The server cannot report the current speed limit or concurrency.** `docs/openapi.yaml` has `PUT` and `DELETE` on
  `/queues/{queue}/rate-limit` and `/concurrency`, no `GET`. Those two cards cannot show the server's value. They show
  what was set from this page in this session, and otherwise say the server does not report it. A `GET` is a new public
  route and a human gate: offered at hand-off, not built.
- A graph of thousands of jobs: it draws only the open rows and refuses over 300 with a note and the list.
- Tests that pin the tree by role: the default view becomes Graph, so those tests choose List on purpose.
- Colour is never the only signal: every node carries `StatusGlyph` and the state word.

## Status

| # | Mini-task | Depends on | Status |
|---|-----------|-----------|--------|
| V1 | Shared read-first card (`ReadFirstCard`) | none | done |
| V2 | Queue Settings cards use it | V1 | done |
| V3 | Cron and Webhooks create forms | V1 | done |
| V4 | Job flows graph with Graph / List switch | none | done |
| V5 | Workflow definition graph | V4 | done |
| V6 | Teaching empty states | none | done |
| V7 | Shared list skeleton (optional) | none | done (no change) |
| V8 | Verify, DESIGN-MAP, README, completion note | V1 to V7 | done |
