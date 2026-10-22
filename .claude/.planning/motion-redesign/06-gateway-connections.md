# 06 — Gateway Connections: the line diagram and its states

**Status:** done · **Depends on:** 03, 05 · **Touches:** packages/panel/src/pages/control/gateway (Connections, ConnectionRow, ConnectionsTable, rules), test, e2e
**Design:** https://claude.ai/artifact/TMMbZ97jDRzvSpWiFVKRuG, boards "Connections (Main)" and "Connection states"

## Goal
Show each connection as source, line, rules and destination on `/events-gateway`, with every state, and keep the table view if the panel has one.

## Steps
1. Read the two boards, `DESIGN-MAP.md` (G1 to G8, the "task 6 checks" notes) and `Connections.tsx`, `ConnectionRow.tsx`,
   `ConnectionsTable.tsx` and their tests. **If drawing the line diagram would lose a view or a control the panel has today
   (G1), stop and record it in the Result. Do not drop it.**
2. Build the row from the task 03 parts: source `ConnectionNode`, `ConnectionLine` with `RuleGlyphs`, `ConnectionPill` (opened as a `HoverCard` that holds a `ConnectionCard`), destination
   `ConnectionNode`. Rows arrive with the stagger (cap 8) on first load; a polled counts change flashes only that figure.
3. The comet runs once on a connection whose polled success count rose since the last poll, never on first load.
4. Every state from the "Connection states" board (Active, Paused, Disabled, Waiting now, failing, empty, loading, error,
   offline, phone) uses the task 05 `feedback` parts and the word-and-glyph rule. Rule descriptions stay the panel's own
   (`connectionRules.ts`).
5. Filters, search and the create link behave as today. The phone form is the vertical line from task 03.
6. Replace the `window.confirm` in `ConnectionRow.tsx` (Remove the connection) with `confirmInPage`, and edit the unit and
   e2e tests that stub the dialog.
7. Count words follow the approved wording: "Successful" and "Waiting now".

## Acceptance
- Every connection the API returns is drawn once, with its state as a word, a glyph and a line pattern.
- The page has no control that was not on it before, and none that `flowOperationPolicy.ts` gates off.
- Remove asks in the page, resolves false on Escape and calls nothing; true calls the same API as before.
- First load staggers at most 8 rows; a poll that changes nothing restarts no animation; a poll that raises one count flashes that figure only.
- Under reduced motion the diagram is drawn complete at once.
- Dark and light both render (`design-tokens`, `accent-split-guard`, `state-colours` pass).

## Verify
```bash
bun test packages/panel/test/gateway packages/panel/test/motion-guard.test.ts packages/panel/test/design-rules-guard.test.tsx && bun run typecheck && bun run lint && bun run format:check && bun run --cwd packages/panel build
```

## Risks / notes
- Board heights are estimates; check the diagram by eye on `bun run --cwd packages/panel dev:stub` at 1280px and 390px.
- Names, addresses and counts on the boards are sample. Never copy them in.

## Result
Done 2026-10-22. Structured view is now the line diagram; the Table view is unchanged.

**G1 (no view or control lost): passed, nothing stopped.** Structured and Table views, the search box, the State select, New
connection and the on/off switch all stay. Events, Send a test event and Remove connection are in a "More" menu in the
Structured view and stay visible buttons in the Table view. Nothing was added that `flowOperationPolicy.ts` gates off; the
menu holds exactly Open, Events, Send a test event and Remove connection (a test pins the list and checks for the gated words).

**New files** (`packages/panel`): `components/ui/ActionMenu.tsx` (menu with arrow keys, Escape, focus back, exit via
`usePresence`), `pages/control/gateway/ConnectionDiagram.tsx` (a section per source) and `ConnectionDiagramRow.tsx` (source line,
pill with hover card, rule glyphs, destination, 24-hour figures, switch and menu). **Changed:** `Connections.tsx`,
`ConnectionRow.tsx` (the Remove question is asked in the page), `ConnectionFigures.tsx`, `ConnectionTrend.tsx`, `model.ts`
(`destinationSub`), `connectionRules.ts` (`FIXED_LABELS`), `lib/useChangeFlash.ts` (`useRises`), `ui/icons.tsx` (`IconMore`).

**Motion.** First load: rows arrive in turn (`--i`, cap 8 in the style sheet). A poll that changes nothing restarts nothing; a row
a poll adds just appears; a poll that raises one count washes that figure only; one comet runs down the line whose success
count rose, never on first load, a fall or an equal read. Reduced motion: everything is in the page at once.

**Remove.** `window.confirm` is gone from this file (1 of 27 in 06; 26 remain for 07 to 13c). Escape, the scrim and Cancel send
nothing; the main button sends the same `DELETE /webhooks/:id` as before.

**Tests edited, not loosened** (the markup they pinned changed on purpose): `gateway-connections.test.tsx`,
`gateway-connections-view.test.tsx`, `gateway-connections-trend.test.tsx` (section label instead of `h3`; menu items instead
of Test and Remove buttons; figures asserted as text; the Table view keeps its column and aria-label checks),
`server-action-pages-03.test.tsx` (Remove through the menu and the in-page question; still exactly one DELETE for a same-tick
double click). New: `gateway-connections-diagram.test.tsx` (8), `ui-action-menu.test.tsx` (7), `useChangeFlash.test.tsx`.

**Test-suite hygiene found on the way.** Two causes of failures that only showed in the whole-panel run:
1. Presence: a dialog, drawer or menu now stays mounted for its 180 ms exit, and a state change inside one `settle()` is
   flushed only when that `act` ends, so a chain "state change, then 180 ms timer" needs two settles. Fixed in
   `layout-fixes.part-02.test.ts` and `control-operation-hardening.part-06.test.tsx` (assertions kept).
2. Leaked shell ownership: `overlay-motion.test.tsx` and `confirm-dialog.test.tsx` end with the global modal store held
   (a confirm over the drawer), which made the mobile-nav tests in `layout-fixes.test.ts` fail. `installTestHooks` in
   `frontend-a11y-fixes.helpers.ts` now resets the store after each test, and `confirm-dialog.test.tsx` clears its question.
   The earlier 10 "order-dependent" failures were failing tests from (1) that left views mounted and polling.

**Ran** (this machine, no Docker, no Postgres): `bun test packages/panel` 1916 pass, 0 fail, 260 files (108 s);
`bun run typecheck` 0; `bun run lint` exit 0 (existing warnings only; none in the new files); `bun run format:check` clean;
`bun run --cwd packages/panel build` ok. Verify's `packages/panel/test/gateway`, `motion-guard` and `design-rules-guard`
are inside that run (the guards pass).
**Not run:** the full repo gate (`architecture`, the other packages), Postgres-backed tests, e2e (needs the stack and a
browser), `dev:stub` by eye at 1280 px and 390 px, the accessibility scan. Task 15 does these. Nothing was rendered, so look
and timing are unseen; the view transition cannot run in happy-dom.

**Deviations from the board (the owner is told in the hand-off; recorded in DESIGN-MAP):**
- The 24-hour popover is not built (the figures and bars are in the row).
- The State chips with counts are not built; the existing State select stays.
- No separate tablet layout: the row is the vertical form below `xl` (1280 px).
- No shaped loading skeleton: `LoadingState` stays. The empty state keeps `WebhookDrawing`.
- "Preview a poll" and its live row are not built (it would fake traffic).
- "More" is read as a container for the existing actions, not a new one.
- The hover card is not anchored to the left edge on narrow windows.
- The Structured view no longer shows the lifetime Success/Fail, Last and events columns. The Table view still does; the
  event count is in the hover card's route line.

**Known risks, unverified:** animations replaying if a re-render ever recreates a node (the tests check node identity across
polls); `confirmInPage` is async where `window.confirm` was synchronous; after a successful Remove the menu button is gone, so
focus is lost to the page; a same-tick double select of "Remove connection" can queue two questions (the hook sends one DELETE).
