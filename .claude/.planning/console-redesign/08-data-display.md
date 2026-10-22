# 08 — Tables, charts, log viewer

**Status:** done · **Depends on:** 04 · **Touches:** packages/panel/src/components/ui (new table recipe, AreaChart, chart parts), packages/panel/src/pages/control/**/log viewer parts, packages/panel/test

## Goal
One recipe for rows, charts and logs, so the page tasks only compose them.

## Steps
1. Table row recipe: a `--cols` grid row (`Table`, `Row`, `Head`, `Cell` helpers or one class set), hover wash on every
   table, selected coral wash plus 3px bar, status bar variants (bad, warn, active, idle), a sticky header on long lists,
   `role="table"` semantics. Existing `<table>` pages are moved by their page task. The recipe must not drop header
   association for screen readers.
2. Charts, as small SVG or div components, no chart library: stacked bars, line with area and a dashed second series,
   horizontal bars with meters, activity heat grid, donut, gantt (for flows). `AreaChart` keeps its props. Every chart has
   `role="img"` and a sentence label (the board's wording).
3. Log viewer: always dark, level badge, queue and job columns, search with hit count, level chips, click for the full
   event (the page's existing behaviour), plus the short `mini-log` for cards.
4. Tests for the recipe's states and for chart labels.

## Acceptance
- Hover, selected and status states are the same on every table (one test renders each and asserts the classes).
- Each chart renders an accessible name containing its numbers, and no chart relies on colour alone (series have a dash
  style or a label).
- The log viewer is dark in both themes and keeps contrast (checked by the token test's log pairs).

## Verify
```bash
bun test packages/panel && bun run typecheck && bun run lint && bun run format:check
```

## Risks / notes
- Charts are the largest hand-written visuals. They stay dependency-free (no new package, so no gate).
- Large tables must keep their current windowing or paging. Only the look changes.

## Result

Primitives only; no page uses them yet (pages adopt them in 09 to 13, and the Logs page in 11).

- **Table recipe** (`ui/Table.tsx`): `TableScroll`, `Table`, `THead` (`sticky`), `Th` (`scope="col"`), `Tr` (`status`, `selected`, `dense`), `Td`. Real `<table>` elements, so header association is kept (deviation R21). The row sets `--rc` and `--bg`; the first cell draws the 3px bar. Hover is the neutral `--hover` wash layered over whatever the row has. Selected is the `--selected` wash plus the `--hl` bar and wins over a status. A status is the bar alone.
- **Charts** (`ui/charts/`, no library): `StackedBars`, `HBars` and `Meter`, `HeatGrid`, `Donut`, `Gantt`, with `Legend` and `tones.ts`. Each is one `role="img"` whose name holds its numbers. A failed series is hatched (`hatch-bad` utility, striped heat cell), and the donut legend spells out values and shares. `AreaChart` keeps its props and gains `dashed` on a series.
- **Log viewer** (`ui/LogViewer.tsx`): `LogBox`, `LogBar`, `LogSearch`, `LogChip` (`aria-pressed`, count), `LogLine` (levels, error wash, an `ERROR`/`WARN` word), `Hit`, `LogScroll`, `LogFoot`, `MiniLog` (`role="log"`). Tokens `--log-*` are defined once and not redefined for light, so it is dark in both themes. They replace the board's raw hex (the state-colours guard bans hex in components).
- **Tests** (new files, 42 tests): `table-recipe.test.tsx`, `charts.test.tsx`, `log-viewer.test.tsx` (log token pairs at 4.5:1 on the background, the toolbar and the error wash).

Ran: panel suite 1464 pass / 0 fail from the repo root; `bun run typecheck`, `lint` (no errors; the warnings are in files this change does not touch), `format:check`, `check-file-size` and `architecture` clean; panel build ok and the built CSS holds `hatch-bad`, `bg-log-*`, the row bar and the hover layer.

Not run: no screenshots (nothing renders these yet, so they are checked on the pages); no Playwright e2e. Search hit count and click-for-event behaviour stay in the Logs page (task 11); `LogSearch` and `Hit` are the parts it uses.
