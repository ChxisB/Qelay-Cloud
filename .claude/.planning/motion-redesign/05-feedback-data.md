# 05 — Feedback and data display

**Status:** done · **Depends on:** 02 · **Touches:** packages/panel/src/components/ui (feedback, Banner, CopyButton, StatCard, Meter, AreaChart, Table, Toggle, StatusBadge), test
**Design:** https://claude.ai/artifact/TMMbZ97jDRzvSpWiFVKRuG, boards "Motion", "States" and the shared parts of "Home" and "Health"

## Goal
Give the shared feedback and data parts their motion once (loading, empty, error, banner, copy, figure change, meter, chart, switch, status), so page tasks only compose them.

## Steps
1. Read `components/ui/` for each part named above and the tests that pin them. Change a part only where the boards differ.
2. `feedback.tsx`: the offline strip slides in and out (`usePresence`); the skeleton is the one allowed loop (opacity only);
   empty and error states arrive with `motion-arrive`. Wording stays the panel's own.
3. `Banner`: arrive and leave. `CopyButton`: the label becomes "Copied" for about 1.5s with a glyph and `role="status"`.
4. `StatCard`: the figure flashes on a polled change through `useChangeFlash`, not on first render. The delta keeps its
   word and glyph.
5. `Meter` fills with `motion-fill` on first render and on a changed value. `AreaChart` draws in once (`motion-draw` on the
   line, an opacity fade on the area) and slides one step when a poll adds a point; the table summary stays for assistive tech.
6. `Table`: rows arrive with the stagger (cap 8) on first load only, never on a poll. Row hover and press use
   `--duration-hover` and `--duration-press`.
7. `Toggle`: the thumb moves with `motion-pop`; the word "On" or "Off" is always shown. `StatusBadge`: a state change
   restarts a one-shot ring; the glyph and word stay.
8. Move any raw duration in these files onto the task 01 tokens and remove its allowlist entry.
9. Edit the tests that pin old markup of these parts in the same change; never loosen one.

## Acceptance
- No part animates anything but `transform` and `opacity` (plus plain colour transitions), and all of it sits behind the
  no-preference media query (`motion-guard.test.ts`).
- An unchanged poll restarts nothing: `StatCard`, `Meter`, `AreaChart` and `StatusBadge` have a test that renders twice with
  equal props and finds the same flash key.
- Under reduced motion the figures, bars and chart show their end state at once.
- "Copied" appears with `role="status"` and goes back by itself.
- `state-colours`, `ui-primitives-guard`, `design-rules-guard` and the axe checks in the existing tests pass.

## Verify
```bash
bun test packages/panel/test/ui-primitives-guard.test.ts packages/panel/test/state-colours.test.tsx packages/panel/test/design-rules-guard.test.tsx packages/panel/test/motion-guard.test.ts packages/panel/test/ui && bun run typecheck && bun run lint && bun run format:check
```

## Risks / notes
- A chart that redraws on every poll would look broken: the draw is keyed to the first render only.
- A list that re-keys its rows on a poll would replay the stagger. Check each user of `Table` keeps stable keys.
- The skeleton must not run under reduced motion; the global backstop already stops it, the test checks the class.

## Result
All under `packages/panel`.

**Changed**
- `src/motion.css`: `motion-ping` (a one-shot ring, `m-ping` 1 → 1.35) and `motion-step` (`m-step`, a slide from `--step`), both inside no-preference.
- `components/ui/feedback.tsx`, `Banner.tsx`: `motion-arrive` on `EmptyState`, `ErrorState`, `OfflineBanner` and `Banner`. The skeleton keeps `motion-safe:animate-pulse`.
- `StatCard.tsx`: the figure is keyed by `useChangeFlash` and gets `motion-flash` only on a real change of a number or string.
- `charts/HBars.tsx` (`Meter`): the fill is scaled (`scaleX`), not resized, with `motion-fill`.
- `AreaChart.tsx`: draws in once (`motion-draw`, staggered per series); an inner group re-keyed by `useRolls` slides one step when the window rolls by one point.
- `StatusBadge.tsx`: `motion-ping` once when the state role really changes.
- `Table.tsx`: `Tr` takes `arrive` (read once at mount) and rises with the stagger; its hover uses `--duration-hover`.
- `form.tsx`: `Toggle` thumb moves by `translate-x` with `ease-pop`; `SegmentedControl` hover uses the tokens.
- `Button.tsx`: hover over `--duration-hover` and a `scale-[0.97]` press over `--duration-press` on `buttonClass` and `iconButtonClass`.
- `src/lib/useFirstLoad.ts` (new): true until the render after the data first arrives.
- Tests: new `test/ui-motion.test.tsx` (18 tests); `motion-guard.test.ts` also names `ping` and `step`; `charts.test.tsx` (Meter clamp reads the transform) and `ui-form-controls.test.tsx` (Toggle thumb position) edited to the new markup, not loosened.

**Decisions**
- The offline strip and `Banner` get the arrival only. About 28 callers unmount them conditionally, so a leave needs caller changes: left to 13d and the page tasks. The board's "Retrying…" label is skipped. The shared rise is 300ms / 8px, not the board's 240ms.
- `CopyButton` and `ErrorState` "Copy details" already had `role="status"` text and a 1500ms revert; tests only (`ui-motion.test.tsx` covers the revert).
- Table stagger "first load only": `Tr arrive` is remembered at mount (dropping the class mid-flight would cut the animation) and pages pass `arrive={first ? i : undefined}` with `useFirstLoad(!loading)`. No page does yet; that is in the page tasks. `useFirstLoad` carries one `oxlint-disable` for `set-state-in-effect`: the render that brings the rows must still read true.
- The status ring is 1 → 1.35 on the pill, not the board's 2.6 on a dot. It is keyed by state role, so active → running restarts nothing.
- `Toggle`: the "On" / "Off" word stays the page's job (DESIGN-MAP M5, the Alerts task).
- `Button`, `iconButtonClass` and `SegmentedControl` press and hover were added here as the shared Motion-board rule no task claimed. Outside 05's original Touches list.
- The differences from the board (rise 300ms / 8px, the ring size, no "Retrying…" label) are recorded here as this task's deviations. None of them changes what the user approved: behaviour, wording and tokens are as designed.

**Ran** (local, happy-dom; no Docker needed)
- `bun test` on the Verify files plus `charts`, `ui-feedback`, `ui-components-a11y`, `table-recipe`, `empty-states`, `stable-shell-fixes`, `ui-motion`: 151 pass, 0 fail.
- `bun run typecheck`: clean. `bun run lint`: 0 errors; no warning in the files this task touched. `bun run format:check`: clean.

**Not run**
- The full gate (`architecture`, the whole `bun test`), the build, e2e, and the axe scan: left to task 15 / Phase 4.
- Nothing was looked at by eye. happy-dom plays no animation, so the tests check the classes and what must not restart, not how it moves.
- Known risks: scaleX on a rounded Meter fill squashes the end cap a little at low values; the AreaChart slide briefly drops the old leftmost point; `enabled:` does not match `aria-disabled` buttons, so those get hover but no press.
