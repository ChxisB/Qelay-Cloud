# 04b — Overlays and the in-page confirm

**Status:** done · **Depends on:** 02, 04a · **Touches:** packages/panel/src/components (CommandPalette*, copilot, ui/Toaster, ui/ConfirmDialog new), globalModalStore, test
**Design:** https://claude.ai/artifact/TMMbZ97jDRzvSpWiFVKRuG, board "Shell and overlays" (S2, S4, S5)

## Goal
Give every overlay an enter and an exit, add the in-page confirm dialog and its owner (approved 2026-10-22), and leave the 27 `window.confirm` calls for the page tasks that own them.

## Steps
1. Read `globalModalStore.ts` and how `CommandPalette.tsx`, `AuthGate.tsx`, `copilot/Copilot.tsx`, `AppLayout.tsx` and
   `database/RowDetailDrawer.tsx` register and restore focus (`mayRestoreModalFocus`).
2. `usePresence` on the palette, the Copilot panel and the drawers: enter 300ms, exit 180ms (S4). The palette gets its moving
   result bar; a loaded drawer value fades in (S5, no new request). A leaving dialog never traps or loses focus.
3. `Toaster.tsx`: rise and leave. Level, time on screen and the Dismiss button stay.
4. New `components/ui/ConfirmDialog.tsx` and a confirm owner in the modal store at priority 90 (above the palette, below the
   authentication gate at 100), with an async helper `confirmInPage({ title, body, confirmLabel, ... })` that resolves
   true or false. Escape and the scrim cancel, focus starts on the safe button, Tab stays inside, focus returns to the opener.
   A typed-word variant (used for Restore, task 13b) keeps the confirm button off until the word matches.
5. Do not replace any `window.confirm` here except as the example in one test. Each page task replaces its own and edits the
   tests that stub `window.confirm`; the status table lists which task owns which call site.
6. Add `test/confirm-dialog.test.tsx` (resolves true and false, Escape cancels, focus trap and return, priority above the
   palette and below auth) and edit the overlay tests for the exit.

## Acceptance
- Every overlay above stays mounted for 180ms on close and unmounts at once under reduced motion; focus returns to the opener.
- `confirmInPage` resolves true on confirm and false on Escape, the scrim and Cancel; two calls queue and never stack.
- The authentication gate is still the highest owner and still has no Escape and no close mark.
- No page file changed except to register nothing.

## Verify
```bash
bun test packages/panel/test/confirm-dialog.test.tsx packages/panel/test/auth-gate.test.tsx packages/panel/test/command-palette-groups.test.tsx packages/panel/test/motion-guard.test.ts && bun run typecheck && bun run lint && bun run format:check
```

## Risks / notes
- `window.confirm` is synchronous and `confirmInPage` is not. The call sites move one by one, with their tests, in the page
  tasks: queues and jobs (10a, 10b), cron (11a), workers and alerts (12b), server, backups and queue-operations consoles
  (13b), benchmark, fleet and settings (13c), gateway events, connections and destinations (06, 08a, 08b), copilot (04b
  itself, `CopilotPanel.tsx`), Bulk add (`useBulkFileInput.ts`) and job logs (10b).
- A dialog that opens inside another dialog must not strand focus: test it from the drawer.

## Result

**Done 2026-10-22.**

What changed (all under `packages/panel`):
- `globalModalStore`: a `confirm` owner at 90. A confirm opened over Copilot or the database drawer records it in `beneath`
  and gives the shell back to it on close; any other owner is replaced as before. `holdsModal(owner)` is true while the owner
  has the shell or sits under a confirm. A stale `beneath` is dropped when that owner goes away first.
- `confirmStore.ts` (`confirmInPage(options): Promise<boolean>`, queue, `answer`) and `components/ui/ConfirmDialog.tsx`
  (mounted in `AppLayout` between the palette and the sign-in gate, z-65). True on the main button; false on Cancel, Escape and
  the dimmed area; two calls queue and never stack; focus starts on Cancel (typed-word variant: on the field, main button off
  until the word matches); Tab stays inside; focus returns to the opener captured when the question was asked. Sign-in
  cancels an open or queued question and hides it at once; while sign-in is up the answer is false.
- Exit 180ms and enter 300ms (`usePresence`, new `useLeavers` for the toast stack): palette (scrim, dialog, the chosen row's
  bar now crossfades), Copilot (scrim, slides in and out), database row drawer (slides, a loaded value fades in; the page
  keeps the last row for the exit), toasts (rise, leave in place, inert while leaving, no auto-dismiss timer while leaving).
  New `.motion-slide-out`. Under reduced motion everything unmounts at once.
- Copilot "Clear chat" is the one `window.confirm` replaced here (`confirmInPage`); the other 26 stay with their page tasks.
- Escape and Tab are not seen by Copilot or the drawer while a confirm is over them; the drawer is `inert` under a confirm.
- Tests: new `confirm-dialog.test.tsx` (14) and `overlay-motion.test.tsx` (6); `frontend-a11y-fixes-02` now drives the in-page
  Clear chat. The shared test hooks and the drawer test reset the modal store before each test (an open palette or drawer used
  to leak into the next file).

Deviations from the board and the plan (record in DESIGN-MAP.md at hand-off):
- Toast rise is the shared 300ms / 8px (`motion-arrive`), not the board's 240ms / 6px.
- Drawer exit slides 28px out (`motion-slide-out`); the board shows only the entry.
- The drawer file is under `pages/` (`RowDetailDrawer.tsx`, `DatabasePage.tsx`, `useDatabaseController.ts`), so "no page file
  changed" holds only for page content: only the open/close plumbing changed. AuthGate motion belongs to 13d.
- The typed-word variant focuses its field first (the main button is off), not Cancel.

Ran (panel tests, Postgres not needed): the 04b Verify command, plus the Copilot, database, toast, shell and guard tests it
touches (99 pass across 16 files), `bun run typecheck`, `bun run lint` (exit 0; the warnings are the existing ones),
`bun run format:check`.
Not run: the full gate and the e2e (task 15); no visual check on `dev:stub` (the exits and the confirm are unit-tested in
happy-dom, which plays no animation); the Copilot exit with the real lazy panel is only exercised through the existing test.
