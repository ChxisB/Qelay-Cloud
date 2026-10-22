# Compact console UI and n8n-style node graphs

Date: 2026-10-21. Scope: `packages/panel` only. Nothing committed or pushed.

## What changed

**Density (Infisical-like).** Done centrally so every page follows:
- `src/index.css`: radii (card 8, control 6, segment 6, key 4), a fixed px type scale (12 / 13 / 14 / 15 / 17 / 20), body
  line height 1.45, one 2px focus ring with a 2px offset, 11px eyebrow. The fluid root now moves spacing only.
- Shared components: `Button` (32px, 28px small, 6px radius, semibold), `IconButton`, `Card`, `PageHeader`, `StatCard`,
  `Table` (cells `px-3`, rows 36 and 40px), form controls (32px, `Toggle` 36x24), `StatusBadge` (24px pill, semibold),
  sidebar, topbar, nav items, node switcher, user block, overview header, queue detail, metrics status panels.
- A bulk class pass over the rest of the panel (padding, gaps, text sizes) so pages with their own spacing follow.

**Node diagrams (n8n-like).** New shared primitives in `src/components/ui/nodegraph/`:
`NodeTile` (square tile, glyph, label under it, input bar, output dot, state badge, D-shaped trigger),
`Connector` (thin curved line with an arrowhead), `nodeIcons` (one glyph per node kind). The `node-canvas` utility in
`index.css` draws the dotted grid.
- `features/flows/ui/FlowGraph.tsx`: one tile per job (queue as title, state word, short id, notes), parent on the left,
  an expand or collapse chip on the line. Layout constants in `flowConstants.ts` (cell 160x144, tile 72, gaps 8) and the
  edge endpoints in `flowGraph.ts` now run tile edge to tile edge.
- `features/workflows/ui/DefinitionGraph.tsx`: the workflow chain as tiles joined by connectors (cell 144, tile 72, gap
  16 in `definitionChain.ts`), first node is the trigger, the dashed rollback return path is kept, vertical stub on a
  phone.
- State is still a shape plus a word, never colour alone. `aria-pressed`, `aria-current`, `aria-label` and
  `data-flow-state` are unchanged.

## Tests

Updated to the new measurements: `ui-primitives`, `ui-form-controls`, `design-tokens`, `design-rules-guard`,
`ui-components-a11y`, `log-viewer`, `table-recipe`, `page-tables-09`, `page-forms-12`, `page-forms-13`,
`flow-graph`, `flow-graph-page`. All 1573 panel tests pass (run from the repo root; the root `bunfig.toml` preload
supplies `localStorage`, so `bun test` inside `packages/panel` alone shows false store failures).

## Gate

`bun run typecheck`, `lint` (0 errors, only existing warnings), `format:check` and `architecture` pass. `bun test`:
2947 pass, 2945 skip (no Postgres, Pub/Sub, ElasticMQ, PgBouncer or TLS up), 1 fail.

The one failure is not from this work: `test/docs/release.test.ts` "package metadata" expects each package `LICENSE` to
drop the `Copyright (c) 2024 Egeo Minotti` line, and every `packages/*/LICENSE` still carries it. Decide whether to drop
the line (as the root LICENSE did in 4103cee) or to relax the test; see the memory note on keeping the MIT copyright
line before changing either.

## Not run

- Playwright e2e (`bun run test:e2e`): not run. The e2e specs under `packages/panel/e2e` may assert old sizes or the
  old graph markup.
- Docker-backed suites (Postgres, emulators): skipped, deferred per the task order.
- Checked by screenshot only (demo mode, port 5273): Overview, Queues, Jobs, Flows graph, workflow definition graph,
  light theme and a 390px phone width for the two graphs. Other pages were not reviewed one by one.
- `FLOW_ROW_HEIGHT` (the virtualised list row) stays at 40px.
