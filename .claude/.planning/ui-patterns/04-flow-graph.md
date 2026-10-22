# V4 — Job flows graph

**Status:** done · **Depends on:** none · **Touches:** packages/panel/src/features/flows, packages/panel/test, packages/panel/e2e

## Goal
A flow is drawn left to right, one node per job, with state, "holds parent" and "waiting on N" on the lines, beside the existing list.

## Steps
1. `domain/flowGraph.ts` (pure): lay out the open `FlowRow`s, column by depth, rows by leaf order, a parent centred on its children. Returns nodes, edges and the size.
2. `ui/FlowGraph.tsx`: HTML `<button>` nodes (`StatusGlyph`, state word, short id, queue) over one SVG layer for the lines. A stuck child's node and line are red. A parent with N unfinished children carries "waiting on N" on its line. A collapsed parent shows "+N" and toggles on click.
3. `FlowExplorer.tsx`: a Graph | List `SegmentedControl`. Graph is the default, List on a narrow screen. Over 300 open rows the graph says so and shows the list.
4. Selecting a node selects the job in `FlowNodePanel`, the same as a tree line; the selected node scrolls into view.
5. Tests: layout (columns, centring, edges), a stuck child is marked, a collapsed parent, the 300 limit, selection. Existing tree tests pick List.

## Acceptance
- The list is unchanged (`role="tree"`, keyboard, virtualised) and is reached with the List switch.
- Every node is a native button with the state in its accessible name; colour is not the only signal.
- No new dependency, no hex colour, files 300 lines or fewer.

## Verify
```bash
LC_ALL=en_US.UTF-8 bun test packages/panel/test/flow-graph.test.ts packages/panel/test/flow-tree.test.tsx packages/panel/test/flow-page.test.tsx
bun run typecheck && bun run architecture
```

## Risks / notes
Truncated views (`view.truncated`) have jobs whose parent is not listed: they are extra top-level nodes, as in the tree.

## Result

- `domain/flowGraph.ts` (pure layout: column by parent, a free row for each job with nothing open below it, parents centred on their
  first and last open child, edges with a `stuck` flag, "waiting on N" counted over the whole flow), `ui/FlowGraph.tsx`, and a
  Graph | List switch in `FlowExplorer.tsx`. Constants `GRAPH_*` are in `flowConstants.ts`.
- Graph is the default on a screen wider than 767px; a phone starts on List. Over 300 open jobs it says so and shows the list.
- **Deviation from the plan text:** "holds parent" and "waiting on N" are written inside the box, not on the line. The gap between
  columns is 64px, too narrow for a readable label, and text in the box is also what a screen reader gets. A stuck line is
  still drawn thicker and in the failure colour, and the box carries the word.
- Every box is a native `<button>` named "<state> job <id> in <queue>, Holds parent, Waiting on N, N tries"; the selected one has
  `aria-current`. The chip on a parent is a second button (`aria-expanded`, "Hide the 2 jobs below root"). Boxes are reached with Tab;
  the arrow-key tree is the List view, kept unchanged.
- The page tests that read the tree now run on a narrow screen (`setScreenWidth(500)` in `installPageHooks`), which is how a phone
  behaves, so they choose List without a click. `flows.e2e.ts` checks the graph (3 boxes, the stuck one, select) and then presses List.
- Ran: `flow-graph.test.ts` (7 layout cases), `flow-graph-page.test.tsx` (7), all `flow*` and `workflow*` tests (147 pass), typecheck,
  architecture, oxfmt check.
- Not run yet: the e2e and a look at it in a browser (V8).
