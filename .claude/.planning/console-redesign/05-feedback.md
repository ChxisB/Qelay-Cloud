# 05 — Feedback: banners, toasts, empty, loading, error

**Status:** done · **Depends on:** 03, 04 · **Touches:** packages/panel/src/components/ui (feedback, Toaster, new Banner), packages/panel/test

## Goal
Empty, loading, error, offline, banner and toast states match the States and Components boards.

## Steps
1. `feedback.tsx`: `LoadingState` becomes skeleton blocks (`aria-busy`, the pulse stops under reduced motion),
   `EmptyState` gets the round icon badge, a title, one sentence and an action row, `ErrorState` shows the message,
   `Retry`, and a `Copy details` button that copies the message, status and code the error already carries (no secrets,
   never `details`). `OfflineBanner` becomes the live strip (glyph, `Disconnected`, text, `Retry`). The buttons keep
   the label `Retry`, not the board's `Try again` / `Reconnect now` (R16).
2. New `Banner` (`info`, `warn`, `ok`, and the default problem tone with `role="alert"`).
3. `Toaster`: glyph, title and small line, bottom right, never blocking, `role="status"` or `alert`.
4. Keep exports and props.

## Acceptance
- A page that rendered `LoadingState`, `EmptyState` or `ErrorState` still does, with no page edit.
- `ErrorState` copies only the error's own message (a test asserts a bearer token in the request does not appear).
- Toast and banner use `role="alert"` for errors and `role="status"` otherwise.
- Skeleton animation is disabled under `prefers-reduced-motion` (already global in `index.css`; a test asserts no
  animation class bypasses it).

## Verify
```bash
bun test packages/panel/test && bun run typecheck && bun run lint && bun run format:check
```

## Risks / notes
- `Copy details` is new behaviour on an error state. It only writes to the clipboard on a click and never sends anything.

## Result
Done 2026-10-20. Changed under `packages/panel/`: `src/components/ui/feedback.tsx`, `Toaster.tsx`, `CopyButton.tsx`
(exports `copyText`), new `Banner.tsx`, `src/index.css` (new `--pop-shadow`, `shadow-pop`); tests `ui-feedback.test.tsx`
(new), `design-tokens.test.ts`, `ui-primitives-guard.test.ts`.

**What changed**
- `LoadingState`: a busy `role="status"` whose label is announced (`sr-only`) and whose skeleton (four rows, `aria-hidden`) is
  drawn with `motion-safe:animate-pulse`, so nothing animates under reduced motion.
- `EmptyState`: round 56px icon badge, 18px/800 title, one sentence, actions row. The dashed frame stays, because pages use
  it both inside a `Card` and on its own.
- `ErrorState`: danger icon badge, title (default `Something went wrong`, new optional `title` prop), message, `Retry`
  (primary) and `Copy details`. The copy is the message, plus `status N` and `code X` when the error has them. Never `details`.
- `OfflineBanner`: the board's live strip: glyph, `Disconnected`, the message, `Retry` as a `Button`.
- New `Banner` (`problem` default with `role="alert"`; `warn`, `info`, `ok` with `role="status"`), tinted with the pill backgrounds.
  No page uses it yet; the hand-rolled notices on pages move to it in tasks 08 to 13.
- `Toaster`: glyph, bold title, `small` detail, 18px radius, `shadow-pop` on the raised surface, a ghost `IconButton` to dismiss.
  An error toast is `role="alert"`, the others `role="status"`. The `aria-live` section stays mounted.
- `copyText` extracted from `CopyButton` so `Copy details` shares its clipboard fallback.

**Deviation R16 (in DESIGN-MAP):** button labels stay `Retry`; the board's `Try again` and `Reconnect now` are not used. About
eight test files and the e2e suite find the button by that name, and the wording carries no behaviour. Say the word and it is
a one-line change plus those tests.

**Tests changed on purpose**
- `ui-primitives-guard.test.ts`: `feedback.tsx` leaves the `rounded-md` allow-list, because the retry is a `Button` now. This
  tightens the guard. The skeleton uses `rounded-[8px]`, the board's value, so the named-radius guard is untouched.
- `design-tokens.test.ts`: the shadow test also covers `--pop-shadow` and `shadow-pop` (file kept at 299 lines).

**Ran, against what**
- `bun test packages/panel`: 1409 pass and 1 fail on the first run (the radii guard, fixed above); after the fix the
  affected files (`ui-primitives-guard`, `design-tokens`, `ui-feedback`) pass, 127 tests. The new `ui-feedback.test.tsx`
  (14 tests) covers busy skeleton and `motion-safe`, badge, `Copy details` content with a bearer token in `details` that must not appear,
  `Copied` and `Copy failed`, strip, banner roles, toast roles, dismiss. Mutation check: making the error toast a `status` failed
  exactly that test; restored.
- `bun run typecheck`, `bun run format:check`, `scripts/check-file-size.ts` (1555 files): clean. `bun run lint`: warnings only,
  none in the files this task changed.
- `bun run --cwd packages/panel build` ok. Screenshot of `/alerts?demo`, dark, 1440x900 (empty states with the round badge). Read by
  eye, not pixel-diffed.

**Seen, not caused by this work:** `test/flow-page-reads.test.tsx` fails when run on its own (`Missing button containing Remove
flow…`: the page renders the viewer notice, so the capabilities store is not operator). It fails the same way with every redesign
change stashed, and passes in the full run, so it depends on test order. Not touched.

**Not run:** root `bun test`, `bun run architecture`, Playwright e2e (task 16). No screenshot of a toast, `ErrorState`,
`LoadingState` or `Banner` in the browser: no demo route shows them. They are covered by render tests only.
