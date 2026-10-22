# 08a — Gateway events, event detail and issues

**Status:** done · **Depends on:** 06 · **Touches:** packages/panel/src/pages/control/gateway (Events, EventDetail, EventTimeline, Issues, IssueCard), test, e2e
**Design:** https://claude.ai/artifact/TMMbZ97jDRzvSpWiFVKRuG, board "Gateway events"

## Goal
Make the event list, one event's path and the issues list read as the same connected story, with motion that only answers a real change.

## Steps
1. Read the board, `DESIGN-MAP.md` (G-numbered deviations for this board) and the files above with their tests.
2. `Events.tsx`: the table uses the task 05 stagger on first load; the status filter keeps its state and gains the shared
   highlight; a new event found by a poll arrives with `motion-arrive` once. Replace the retry-all `window.confirm` with
   `confirmInPage` (same text, same API).
3. `EventDetail`/`EventTimeline`: draw the path source, rules, destination with the task 03 `ConnectionLine`; each attempt is a
   step on it, drawn in order on first load. Attempts keep their time, status word and glyph.
4. `Issues`/`IssueCard`: cards arrive with the stagger; opening a card uses a height-free reveal (`transform` and `opacity`
   on the content, the card grows by layout, not by animating height).
5. Edit the tests and e2e that stub the dialog or pin old markup in the same change.

## Acceptance
- The list, filters, pagination and detail keep every field and link they have.
- Retry-all asks in the page and calls the same API on true, nothing on false.
- A poll with the same events animates nothing.
- Attempt order and times on the timeline are unchanged; each step has a word and a glyph, not colour alone.

## Verify
```bash
bun test packages/panel/test/gateway packages/panel/test/motion-guard.test.ts && bun run typecheck && bun run lint && bun run format:check
```

## Risks / notes
- Long payload text and wide tables: check a 120-character value and a phone width by eye.

## Result
Done 2026-10-22. Events rise in order, the event opens as a sheet under 1280 px, its attempts are a line, and an issue shows the line it is about.

**G1 (no view or control lost): passed, nothing stopped.** The Events list, filters, saved views, paging, Refresh and Retry all
keep their fields, links and API calls. The detail keeps its Card, status pill, Retry, "On hold" banner and Facts; `Issues`
keeps its tabs, counts and the viewer/operator split (a viewer reads, an operator moves an issue between the four tabs, as
`Issues.tsx` already did, so the board's note matches the code). No new control, route or API call. Nothing was added that
`flowOperationPolicy.ts` gates off.

**New files** (`packages/panel/src/pages/control/gateway`): `EventsTable.tsx` (the table, moved out of `Events.tsx` to stay under
300 lines; the row button keeps `aria-pressed` and its label), `EventSheet.tsx` (bottom sheet: scrim, Tab trap, Escape, focus
return, claims the `event-sheet` owner), `AttemptLine.tsx` (the attempts as stops on a line). `src/lib/useMinWidth.ts` and
`src/lib/useRowArrivals.ts`. **Changed:** `Events.tsx`, `EventDetail.tsx`, `IssueCard.tsx`, `Issues.tsx`,
`ui/nodegraph/ConnectionLine.tsx` (a `tone` prop: `cn` does not merge, so a colour cannot ride in `className`),
`globalModalStore.ts` (owner `event-sheet`, priority 30, under the confirm).

**Motion.** Events rows rise in a stagger on the first load of a filter; a poll that finds a new event makes that row rise once
(place 0) and leaves every other row the same DOM node; another filter, range or page just appears. Issue cards do the same.
The detail is a sheet under 1280 px (300 ms in, 180 ms out) and a column with a 300 ms arrive at 1280 px and over. The
attempts arrive stop by stop. Reduced motion: the sheet and every row are in the page at once and gone at once.

**Words.** Each stop says "Attempt n", Failed or Sent, the time, "took x", "HTTP code" or "HTTP no answer", and the reason;
the last stop is the event's status ("On hold" when the connection is off). A square stop is a failure and a round one is not,
so the shape says it without the colour. An issue line says **Still trying** (solid, red), **Stopped itself** (dashed, red, the
connection paused itself after failures) or **Recovered** (solid, green). These three phrases are new wording and need the
owner's word.

**Question.** `window.confirm` is gone from Events: "Retry every failed event of this connection (up to 500)?" is asked in the
page with "Retry all failed"; false and Escape send nothing, true sends the same call. 23 call lines remain in `src`
(`useDestinationRemove.ts` is next, in 08b); task 14's guard settles the count.

**Tests.** Edited, not loosened: `gateway-events.test.tsx` (retry-all asks in the page, with the dialog mounted after the
page). New: `gateway-events-motion.test.tsx` (10: first-load stagger, a poll leaves rows alone, a poll adds one row at place 0,
another filter does not rise, the sheet opens/closes with Escape, scrim and Close and returns focus and releases the owner, a
wide window keeps the column and claims nothing, reduced motion, attempt order and words, Sent and "no answer", On hold) and
`gateway-issues-line.test.tsx` (3: the three states in words and pattern, ends and viewer, stagger and poll).

**Ran** (this machine, no Docker, no Postgres): `bun test packages/panel` 1943 pass, 0 fail, 264 files (111 s);
`bun run typecheck` 0; `bun run lint` exit 0 (existing warnings only; none from the new files); `bun run format:check` clean;
`bun run --cwd packages/panel build` ok.
**e2e:** no spec drives the retry-all question or the issue cards, so none was edited.
**Not run:** the full repo gate (`architecture`, the other packages), Postgres-backed tests, e2e (needs the stack and a browser),
`dev:stub` by eye at 1280 px and 390 px, the accessibility scan. Task 15 does these. Nothing was rendered, so look and timing are unseen.

**Deviations from the plan and board (recorded in DESIGN-MAP):**
- No sliding highlight on the status chips (they cross-fade through `Button`).
- Rows do not become cards on a phone; the table keeps its horizontal scroll.
- "Preview a poll" from the board is not built (no source for it in the panel).
- The attempts are a vertical list of stops, not a drawn line: `motion-draw` only scales sideways, so the stops arrive in order
  instead. The source, rules and destination path is not redrawn in the detail; its Facts already say From and To.
- Issue cards have no opening reveal: they have nothing to open.
- The sheet dialog is labelled "Event"; the inner "Event details" section is kept so existing tests and readers still find it.

**Known risks, unverified:** the Tailwind classes in `AttemptLine` and `EventSheet` (`max-h-[85dvh]`, `rounded-t-card`, `-left-6`,
`ring-surface`, the spine alignment) and the issue line grid have not been seen in a browser; focus return relies on
`document.activeElement` when the sheet mounts, which Safari does not set when a button is clicked; `confirmInPage` is async
where `window.confirm` was sync.
