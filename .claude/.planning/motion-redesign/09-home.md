# 09a — Home: the Job flow

**Status:** done · **Depends on:** 03, 05 · **Touches:** packages/panel/src/pages/control (OverviewPro, overview/JobFlow, overview/OverviewTiles), components/ui/nodegraph/ConnectionLine, motion.css, test
**Design:** https://claude.ai/artifact/TMMbZ97jDRzvSpWiFVKRuG, board "Home" (Home H1)

Task 09 was split in two when the board was read: this part is the seven tiles becoming one connected flow (H1), which needs
vertical lines; [09b](09b-home-states.md) is the rest of the board (H2 to H5).

## Goal
Replace the seven figure tiles with one "Job flow": ready backlog, active and completed joined by lines, with delayed
feeding the backlog and failed branching off active.

## Steps
1. Read the board, `DESIGN-MAP.md` ("Home H1") and `OverviewPro.tsx`, `overview/OverviewTiles.tsx` with their tests.
2. `motion.css`: a downward line draw and comet (`motion-draw-y`, `motion-comet-y`), inside the no-preference query.
   `ConnectionLine` takes `vertical` (line, arrow head, dash pattern and comet turn down); horizontal output is unchanged.
3. `overview/JobFlow.tsx` (new) replaces `OverviewTiles.tsx`: a wide grid from 1024 px, one column below it. Nodes keep
   every number, hint and the amber threshold the tiles had; Failed joins only while `failedTotal > 0`. A line pulses only
   when the figure it feeds changed (a rise for push, completed and failed; any change for the pull and delayed lines).
4. One sentence for a screen reader (`sr-only`); the lines and the rate pills are `aria-hidden`.
5. Edit the tests that pin the old markup in the same change.

## Acceptance
- Every figure and hint the tiles had still shows; Failed only while failures are recorded. No new request.
- A poll that changes nothing animates nothing; a changed figure washes once; only a line fed by a rise sends a comet.
- A state is its word and a glyph (waiting, active, completed, failed); Delayed has none, as it has no state glyph today.
- Narrow screens get one column; reduced motion shows the end state (the rules sit inside the no-preference query).

## Verify
```bash
bun test packages/panel/test/home-job-flow packages/panel/test/overview packages/panel/test/home packages/panel/test/motion-guard.test.ts && bun run typecheck && bun run lint && bun run format:check
```

## Risks / notes
- The plan's "top strip of gateway connections" is not built: the board has no such strip (deviation).
- New wording "Job flow", "Where jobs are, as last read. The lines show direction only." and "Completed counts since the server
  restarted" needs the owner's word (DESIGN-MAP.md, new-wording item 4).
- Narrow layout: Delayed and Failed sit below the main column as side branches with no line (the sentence carries the relation).
- Grid and line classes are unseen in a browser.

## Result
Done 2026-10-22.

**Changed** (all under `packages/panel`):
- `src/motion.css`: `m-draw-y`, `m-comet-y`, `.motion-draw-y`, `.motion-comet-y`, inside the no-preference query.
- `ConnectionLine.tsx`: `vertical` prop (line, arrow head, dash pattern and comet turn down); horizontal markup is unchanged.
- `overview/JobFlow.tsx` (new) replaces `overview/OverviewTiles.tsx` (deleted); `OverviewPro.tsx` mounts it. `StatCard.tsx` now exports `toneClass`.
- Tests: `home-job-flow.test.tsx` (7: figures and hints, Failed joining with its own line, the screen-reader sentence, amber, a poll
  washing only the changed figure and sending a comet only after a rise, the stagger, the narrow column); `motion-guard.test.ts`
  also names `draw-y` and `comet-y`; two test names in `overview-render.test.tsx` say "node" for "tile".

**Ran:**
- `bun test packages/panel/test/home-job-flow packages/panel/test/overview packages/panel/test/home packages/panel/test/motion-guard.test.ts packages/panel/test/nodegraph`: 62 pass, 0 fail.
- `bun run typecheck`, `bun run lint` (exit 0; the pre-existing warnings only), `bun run format:check`: clean.
- `bun run --cwd packages/panel build`: built.
- `bun test packages/panel`: 1960 pass, 0 fail, 267 files, 110 s (lid open, battery 98%).

**Deviations:** the plan's gateway-connections strip is not built (the board has none); narrow screens put Delayed and Failed under the
column with no line; new wording needs the owner's word (see DESIGN-MAP.md, H1 outcome).

**Not run:** by eye in a browser (the grid, line and node classes are unseen, including that the first figure stays above the fold at
1280×720); e2e; the full repo gate and Postgres-backed tests (task 15).
