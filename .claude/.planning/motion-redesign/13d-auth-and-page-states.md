# 13d — Sign in and page states

**Status:** done · **Depends on:** 04b, 05 · **Touches:** packages/panel/src/components (AuthScreens, AuthGate, RouteGate, ErrorBoundary), pages (NotFound, NotAvailable), components/ui (feedback, Banner), test, e2e
**Design:** https://claude.ai/artifact/TMMbZ97jDRzvSpWiFVKRuG, board "States" (SS1 to SS9)

## Goal
Give the sign-in screens, the token lock and every full-page state one calm entrance and exit, and keep the lock as strict as today.

## Steps
1. Read the board, `DESIGN-MAP.md` ("States and sign in", SS1 to SS9) and the files above with their tests.
2. SS1: the card rises, text crossfades between states, the dialog and the offline strip enter and leave. Use the task 02
   utilities and `usePresence`. The token lock card uses `motion-pop` once. Every cue becomes an instant change under reduced
   motion.
3. SS2: the token lock keeps no Escape, no close mark and no click-outside; Unlock stays off until there is text. Its owner
   priority (100) is unchanged.
4. SS4: the 404 numeral is decoration and hidden from a screen reader (`aria-hidden`); check that the panel does the same.
5. SS8: the offline strip keeps its glyph, word and sentence; it gains an enter and a leave only.
6. States that exist in the panel but not on the board (config error, route check, crash) take the same entrance, nothing more.
7. Edit the tests that pin old markup in the same change.

## Acceptance
- Sign in, config error, token lock, 404, not available, route check, crash and offline strip each still show their glyph, word
  and action.
- The token lock still cannot be dismissed without a token (existing `auth-gate` tests pass unchanged in meaning).
- Focus lands in the first field on sign in and in the token field on the lock; the controlled password field keeps focus while
  typing (no remount on re-render).
- Reduced motion: no entrance, no exit delay.

## Verify
```bash
bun test packages/panel/test/auth-gate packages/panel/test/route-gate packages/panel/test/page-states packages/panel/test/empty-states packages/panel/test/ui-feedback packages/panel/test/async-ui-state-fixes packages/panel/test/brand-assets.test.tsx packages/panel/test/motion-guard.test.ts && bun run typecheck && bun run lint && bun run format:check
```

## Risks / notes
- Visual only: no change to auth logic, roles, sessions or the sign-in API (an auth change would be a human gate).
- A controlled input inside an element that animates on mount must not remount on each keystroke; keep the animation on a
  wrapper that is stable across renders.
- The board's Retry behaves differently from the panel (SS6): the panel's behaviour stays.

## Result
Done 2026-10-22.

**Changed.** `AuthScreens.tsx`: the card carries `motion-arrive` (once) and its text sits in a wrapper keyed by the title with
`motion-fade`, so a change of screen fades the new text in while the card stays. `AuthGate.tsx`: the lock uses `usePresence`,
its scrim is now a separate `aria-hidden` element (`motion-fade`, then `motion-fade-out`), the card is `motion-pop` on opening
and `motion-leave` on closing, and the wrapper is `inert` while it leaves. Focus restore, the inert background and the draft
reset still happen the moment the lock is dismissed. No change to auth logic, roles, sessions or the sign-in API.

**Already true, no change.** Config error (same card), the 404 numeral (`aria-hidden`), not available, operator only, route
check loading and failure, crash and the offline strip all already enter with `motion-arrive` (task 05) and keep their glyph,
word and action. Sign-in has no field, so nothing takes focus there, as today; the lock still focuses its token field.

**Deviations (in DESIGN-MAP, need the owner's word).** The text change is a fade-in of the new text, not a crossfade with the
old. The offline strip enters but does not leave (38 call sites, and a leave that moves only transform and opacity would leave
the content below to jump anyway).

**Tests.** New `test/auth-motion.test.tsx` (7 tests: the card rises once and the text re-fades; config error; the lock pops in
and the input keeps its element and focus through typing; Escape, click outside and a close mark do nothing and Unlock waits
for text; unlocking saves the token, then leaves with `motion-leave`, `inert`, and is gone after 260 ms; reduced motion closes
at once). Two `auth-gate` tests now wait 260 ms for the leave before asserting the dialog is gone.

**Ran.** The 13d Verify set plus `design-rules-guard` and `ui-primitives-guard` (100 pass, 0 fail), root `bun run lint` (exit 0),
`bun run format:check`, `bun run architecture` and the panel `bun run typecheck`, all clean. Not run: the full panel suite
(left to the next task that touches shared parts, and task 15), e2e, Postgres, the panel in a browser (so the lock's pop and
leave, the scrim split and the text fade are unseen), Docker.
