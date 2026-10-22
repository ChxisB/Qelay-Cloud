# V5 — Workflow definition graph

**Status:** done · **Depends on:** V4 · **Touches:** packages/panel/src/features/workflows, packages/panel/test

## Goal
The definition is a left-to-right chain: the current step marked, finished steps ticked, a dashed return path while it rolls back, click a step for its detail.

## Steps
1. Read `workflowWire.ts`, `ExecutionDetail.tsx` and `StepTimeline.tsx` for what a recorded step holds, and match steps to nodes by name.
2. `DefinitionGraph.tsx` draws the chain with the shared line layer from V4; branch, parallel and loop nodes list their steps inside the node (as `describeNode` does).
3. Pass the run's state in; when it is compensating or compensated, draw a dashed line back to the first node.
4. Clicking a node shows its definition and, for a step, its recorded input and output underneath.
5. Keep the text list as the accessible alternative (the `<ol>` stays, in a disclosure or as the narrow-screen view).

## Acceptance
- `aria-current="step"` stays on the current node.
- A run with no recorded definition still says so.
- Payloads shown are the ones the server returned, with the truncation marker kept.

## Verify
```bash
LC_ALL=en_US.UTF-8 bun test packages/panel/test/workflow-steps.test.tsx packages/panel/test/workflow-page.test.tsx
bun run typecheck
```

## Risks / notes
Two nodes can share a step name: match by position within the run, not by name alone, and say so in Result if a case cannot be told apart.

## Result

**Changed** (`packages/panel/src/features/workflows`):
- `ui/DefinitionGraph.tsx` is a left-to-right chain of boxes joined by arrows. A box is a button and opens its detail below.
  The chain is the `<ol aria-label="Nodes of the workflow">`, so it is its own accessible list; there is no second list.
  `aria-current="step"` sits on the current `<li>`. Below `md` the chain stacks top to bottom and the dashed line is
  hidden: the note above the chain says the same in words.
- `ui/NodeDetail.tsx` (new): the node's kind, detail and steps from `describeNode`, then for one step its status, tries,
  time, error and `result` through `PayloadView`, so the truncation note and marker are kept.
- `domain/definitionChain.ts` (new, pure): `nodeMark`, `returnPath`, `recordedFor`, `isRollingBack`.
  `domain/workflowDisplay.ts` gained `nodeStepNames`. `ExecutionDetail.tsx` now passes `state` and `steps` (the `live` prop is gone).
- It opens on the node the run is at when the run is live; otherwise on a hint.

**Decisions**
- **Marks.** Done, "The run is here" and "Not reached" only while the run is going forward (running, waiting). A
  finished run has every node Done. While rolling back only the cursor is marked. A failed run is not marked: the server
  gives `currentNodeIndex` as a count for it, not a place.
- **Dashed return line.** Drawn only for `compensating` and `compensation-stuck`, from the cursor node back to the first, danger colour when stuck.
  A run that has already finished rolling back (`failed` with `rollbackStatus: 'completed'`) gets no line: the server does not
  say which node it stopped at, so a line would be a guess. Its rollback is still on the Summary and Steps tabs.
- **Step matching by name, never guessed.** A node's recorded step is shown only when the node holds one step name, that
  name is used once in the whole definition (branch and loop steps included) and once in the first page of recorded steps. Else the
  detail says the name is used more than once (or is not on the first page, or has not started) and points to the Steps tab.
  Cases that cannot be told apart: a step inside a loop (one name, many records), and two nodes with the same step name. The plan's
  "match by position" has no data behind it: a recorded step carries no node index.
- **Input.** A recorded step has a `result` but no input, so only the output is shown. A fan-out shows its counts line, not 10,000 iterations.
- Constants: the box is 208 px and the arrow 64 px (`CHAIN_NODE_WIDTH`, `CHAIN_GAP`); the classes `md:w-[208px]` and the
  arrow `svg` width must match them, or the return line drifts. They are in px for that reason.

**Ran** (panel unit tests, no Postgres needed): `LC_ALL=en_US.UTF-8 bun test packages/panel/test/definition-chain.test.ts packages/panel/test/workflow`
58 pass, 0 fail (new: `definition-chain.test.ts`, `workflow-definition-graph.test.tsx`). `bun run typecheck` and `bun run architecture` clean; oxfmt clean;
oxlint only the existing warning class (`no-array-index-key` on the node list, as before).
**Not run yet:** the e2e check added to `e2e/workflows.e2e.ts` (the stuck-rollback test opens the Definition tab). It is
checked in V8 with the other e2e. If the e2e worker announces no definition, that step will need a changed assertion.

