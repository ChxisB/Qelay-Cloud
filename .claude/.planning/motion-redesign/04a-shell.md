# 04a — Shell

**Status:** done · **Depends on:** 02 · **Touches:** packages/panel/src/components/layout, test
**Design:** https://claude.ai/artifact/TMMbZ97jDRzvSpWiFVKRuG, board "Shell and overlays" (S1, S3, S6)

## Goal
Move the sidebar, the top bar, the health badge and page changes, and the phone menu, with the shared patterns.

## Steps
1. Sidebar (`Sidebar.tsx`, `NavItem.tsx`, `NavGroup.tsx`): one shared highlight that slides to the current item (S1), measured
   from the item's position on mount and on a fold; without script or under reduced motion each item draws today's wash. Group
   folds fade their pages in; the folded count and the current-page dot are new.
2. `ConnectionBadge.tsx`: a one-shot flash on a changed state, restarted by `useChangeFlash`, and a status line under the
   card that is shown and announced only when a poll changes the state (S3, `role="status"`).
3. Page change: `src/lib/pageTransition.ts` wraps a nav click in `document.startViewTransition` (links call
   `startPageTransition` from `onClick`; `AppLayout` calls `settlePageTransition` once the new location has rendered).
   React Router's `viewTransition` prop is not used: `BrowserRouter` ignores it and only a data router honours it. It must
   not move focus and must keep `useRouteScrollReset` working. A browser without the API, reduced motion, a modified click or
   a link to the current page just changes the page.
4. Alerts nav item: a count dot and the name "Alerts, 3 triggered" (S6), from the count the panel already has. No new request.
5. Phone menu (`Sidebar.tsx`): the slide exists; only its timing changes (enter 300 ms, exit 180 ms), and the scrim fades
   out for the exit time (`usePresence`).
5a. Added: the theme toggle swaps its two icons instead of replacing one (`Topbar.tsx`).
6. Edit the tests that pin the old markup of these files in the same change; never loosen one.

## Acceptance
- With motion on, the highlight slides; with reduced motion or without a measurement it is the old wash. Both render the
  current page with `aria-current`.
- A badge change restarts its flash once; a poll with the same state does nothing and announces nothing.
- A nav click asks for a view transition through the own helper, and focus and scroll behave as before (existing route-reset
  tests pass). The helper does nothing for a missing API, reduced motion, a modified click or the current page.
- The Alerts link is named with its count and carries a dot only when the count is above zero.
- The phone menu opens and leaves with the same slide timing and returns focus to its button.

## Verify
```bash
bun test packages/panel/test/layout packages/panel/test/nav- packages/panel/test/shell packages/panel/test/stable-shell-fixes packages/panel/test/app-routes-complete.test.tsx packages/panel/test/motion-guard.test.ts && bun run typecheck && bun run lint && bun run format:check && bun run --cwd packages/panel build
```

## Risks / notes
- The held old picture can outlast a lazy route's first chunk; the helper lets go after 1 s.
- A layout read on mount must not run on the server render or in `happy-dom` without a fallback.
- Name the test files that exist when you start, in the Result.

## Result

**Changed** (all under `packages/panel`): `src/lib/pageTransition.ts` (new), `src/motion.css` (+`motion-fade-out`, the sidebar
highlight and the view-transition rules), `src/components/layout/` (`Sidebar`, `NavGroup`, `NavItem`, `navConfig` +`isNavCurrent`,
`ConnectionBadge`, `Topbar`, `AppLayout`), `src/lib/useChangeFlash.ts` (doc only), `test/motion-guard.test.ts` (the raw-duration
allowlist is now empty, which was task 14's step).

**Plan corrections.**
- Step 3 said to pass `viewTransition` to links. The app uses `BrowserRouter`, which ignores it (only a data router honours it,
  and `useViewTransitionState` throws outside one). Replaced with the own `startPageTransition` / `settlePageTransition` pair;
  the step and the acceptance line are rewritten above.
- Step 5 no longer needs `usePresence` for the drawer: the drawer is a CSS transition with new timings. `usePresence` is used
  for the scrim only.
- Added the theme-toggle icon swap (S1 shows it) as 5a.

**Deviation (health line).** The status line under the card says "Control API is healthy / reachable but degraded / not
answering" instead of the board's sample wording, because the panel's own states are those three words. It is silent on the
first answer and on a poll that does not change the state.

**Tests.** New: `shell-motion.test.tsx` (13: highlight with and without a layout, group fold and count pill, current-page dot,
badge flash and line, Alerts count and dot, theme toggle, drawer timings and scrim exit) and `page-transition.test.ts` (12: the
helper against a fake `startViewTransition`). Existing tests that pin the shell markup passed unchanged.

**Ran.** `bun test` on layout, nav-, shell, stable-shell-fixes, page-transition, app-routes-complete, motion-guard and
async-ui-state-fixes: 98 pass, 0 fail. Root `bun run typecheck`, `bun run lint` (no warning in a file this task added; the
Sidebar layout effect carries a disable comment with its reason), `bun run format:check`, and `bun run --cwd packages/panel
build`: all pass.

**Not run.** No browser: the sliding highlight, the view transition and the flash are checked by class, style and a fake API,
not by eye. A first load of a lazy route can hold the old picture for up to a second. The full gate and e2e wait for task 15.
