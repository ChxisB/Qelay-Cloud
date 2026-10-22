# 11b — Flows and workflow runs

**Status:** done · **Depends on:** 03, 05 · **Touches:** packages/panel/src/features/flows/ui, src/features/workflows/ui, pages/control (Flows, Workflows), test, e2e
**Design:** https://claude.ai/artifact/TMMbZ97jDRzvSpWiFVKRuG, board "Automation" (flows and runs part)

## Goal
Bring the flow graph and workflow runs onto the shared connected language and motion, keeping the owner-approved action exceptions as they are.

## Steps
1. Read the board, `DESIGN-MAP.md` (deviations for "Automation", including A5 and A6) and the files above with their tests.
2. The flow graph already uses `NodeTile` and `Connector`: it takes the task 03 draw-in and state patterns. Nodes arrive in graph
   order, once, on first load.
3. A step's state change in a polled run flashes that node once and runs the comet along the edge it finished.
4. **Keep as today** (approved 2026-10-22): the Flows explorer actions (A5) and the workflow-run actions (A6). Do not add
   to them, do not remove them, and do not move their confirms in this task. The confirm text stays as it is.
5. Edit the tests that pin old markup in the same change.

## Acceptance
- Graph, explorer actions and run actions are as before, apart from motion and the shared patterns.
- A run that has not changed since the last poll animates nothing.
- Each node state is a word and a glyph.

## Verify
```bash
bun test packages/panel/test/flow packages/panel/test/workflow packages/panel/test/nodegraph packages/panel/test/queue-settings-operations-hidden.test.tsx packages/panel/test/mutation-action-guards packages/panel/test/motion-guard.test.ts && bun run typecheck && bun run lint && bun run format:check
```

## Risks / notes
- A large graph (hundreds of nodes) must not stagger past 8; only the first 8 delay.

## Result

**Built 2026-10-22.**

Changed (under `packages/panel`):
- `src/components/ui/nodegraph/Connector.tsx`: a `pulse` prop (default 0). When it goes up, the `<g key={pulse}>` remounts with `motion-draw`, so the line draws parent to child once more. A `Connector` with neither `index` nor `pulse` renders as before.
- `src/features/flows/ui/FlowGraph.tsx`: the jobs and lines of the first load arrive in graph order (`useFirstLoad`, the place read once per component, `motion-arrive` and `stagger(depth)`); a job whose state really changes washes its state word once and the line into it draws again (`useChangeFlash`). Jobs and lines that expand, poll or page in later do not animate. The explorer actions (A5) and `FlowNodePanel` are untouched.
- `src/features/workflows/ui/DefinitionGraph.tsx`: the chain's nodes arrive in order with their lines (the mobile vertical line uses `motion-draw-y`); when the run moves on, only the node it left and the node it reached wash their word and redraw the line.
- `src/features/workflows/ui/StepTimeline.tsx`: steps of the first load rise in order with their vertical line; a step that a later render adds does not.
- `src/features/flows/ui/FlowList.tsx` and `src/features/workflows/ui/ExecutionList.tsx`: rows of the first load rise in a stagger (`Tr arrive`); the Jobs count and the Node number are `Figure`, so they wash only on a real change. The state pills already ping on a change (`StatusPill`/`StatusBadge`).

Tests (none loosened):
- New `test/flow-motion.test.tsx` (8): first-load order and the late job that does not arrive; a poll that changes nothing replaces nothing and washes nothing; one state change washes one word and redraws one line, and the same data again restarts nothing; every job has a glyph and a word; flow list stagger, count wash and no rise for a later row; workflow chain order, a run moving on marks two nodes; step timeline first load against later; executions stagger and a changed node number washes.
- The existing flow, workflow and nodegraph tests pass unchanged.

Ran: the 11b Verify set (202 pass, 0 fail, 27 files); `bun run typecheck`; `bun run lint` (exit 0); `bun run format:check`. Full panel suite from the repo root: 2008 pass, 0 fail, 273 files (122 s).

Acceptance: the graph, the Flows explorer actions (A5) and the run actions (A6) are as before; no confirm moved and no text changed. A poll that changes nothing replaces no element and washes nothing (tested for the graph, the chain, both lists). Each node state is a word and a glyph (tested for the flow graph; the chain and timeline already drew both).

Deviations from the plan:
- The "comet along the edge" is a re-draw of that line. The motion guard allows only `transform` and `opacity` to move, which cannot carry a gradient along an SVG bezier; the HTML comet needs a straight box.
- No dot pop on `StepTimeline`: `motion-pop` has no stagger delay, so it would be invisible on later steps. Each step rises with its line instead.
- The node flash is a wash on the state word, not a ring on the glyph badge. The wrapper is `absolute` (`motion-flash` sets `position: relative`) and a key change on the button would drop its focus, so the wash sits on a small keyed span inside it.
- Arrival is on the first load only, as the plan says. The place is read once per component, so a poll never restarts an animation. The CSS caps the stagger at 8 (`min(var(--i, 0), 8)`), so a graph of hundreds of nodes does not stagger past it.

Not run: the full repo gate (`architecture`, other packages), Postgres-backed tests, the e2e, `dev:stub` by eye at 1280 px and 390 px, the accessibility scan. The motion is unit-tested only. Unseen in a browser: the word wash inside the `truncate` parent of a flow node, the chain's SVG redraw, the timeline's line and the stagger of a large graph.
