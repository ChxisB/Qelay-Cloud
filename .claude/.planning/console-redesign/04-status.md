# 04 — Status glyph, pills, tags, key figures

**Status:** done · **Depends on:** 02 · **Touches:** packages/panel/src/components/ui (StatusBadge, new StatusGlyph, StatCard, new Tag), packages/panel/test

## Goal
One status vocabulary everywhere: a glyph and a word, never colour alone.

## Steps
1. New `StatusGlyph` (exported from `StatusBadge.tsx`, which stays under the line cap): the ring motif (`ring`, `half`,
   `mark` paths from `qnav.js`), one shape per state role. Decorative (`aria-hidden`), always rendered beside its word.
2. `StatusBadge`: keep `stateRole` and the `STATE_*` maps (many callers). Render glyph plus label. Keep `StatusDot`.
3. Pills (`ok`, `warn`, `bad`, `act`, `rose`, neutral) and `Tag` for transport (Pub/Sub, SQS, Postgres) as small components.
4. `StatCard` becomes the key-figure tile: label, value, foot line (`hint`), optional sparkline (`spark` prop, an array of
   numbers; the path maths ported from `Q.spark` into `Spark.tsx`). Existing props keep working. `tone` maps to the tile's
   colour. Unit and delta pills are not built: no caller has either, so they wait for the page task that needs them.
5. ~~Eyebrow component used by `PageHeader`.~~ Dropped: the boards have no `.eyebrow` rule and no eyebrow on page titles
   (task 03 recorded the same). `StatCard` no longer uses the `eyebrow` class.

## Acceptance
- Each state in `STATE_ROLE` renders a glyph, and the glyph is `aria-hidden` while the label text is present.
- `StatCard` without `spark` renders as before apart from style. With `spark` it renders one `svg` with `aria-hidden`.
- No colour class carries a status without a word next to it in the new components (test over a rendered sample).

## Verify
```bash
bun test packages/panel/test && bun run typecheck && bun run lint && bun run format:check
```

## Risks / notes
- Task 02 remapped the state tokens to the design's mapping: waiting is amber, delayed is rose. `StatusDot` tone `zinc` and
  `StatCard` tone `waiting` read `--state-waiting-fg`, so they are now amber. Repoint `zinc` to `--idle` (`bg-idle`) and
  update `state-colours.test.tsx` here, because `zinc` means neutral.
- The design has seven glyph kinds and the panel has six state roles. The mapping is written next to `STATE_ROLE` and
  stated in the Result.

## Result
Done 2026-10-20. Changed under `packages/panel/`: `StatusBadge.tsx`, `StatCard.tsx`, new `Spark.tsx` and `Tag.tsx`;
tests `state-colours.test.tsx`, `ui-primitives.test.tsx`, new `ui-status.test.tsx`. No token change.

**What changed**
- `StatusGlyph` (in `StatusBadge.tsx`): the design's 18px ring, filled for completed and failed (mark cut out in the
  surface colour), half filled for active, outlined with a mark for the rest. `StatusBadge` is now the design's pill:
  26px, state tint, an inset hairline in the state colour, glyph, then the word. `stateRole`, `STATE_PILL`, `STATE_SOLID`,
  `STATE_TEXT` and `STATE_ROLE` are unchanged, so `QueueDetailSections` and `StatusConsole` need no edit.
- Glyph per role (the design has seven kinds, the panel six roles): completed = tick, failed = cross, active = half ring,
  waiting = dash (design "idle"), delayed = clock (design "delay"), prioritized = up arrow (not in the design: the board
  has no prioritized state, so this one is mine). The design's paused ("man") and warning kinds have no job-state role,
  so they are not ported; the later task that needs them adds them.
- `StatusDot` tone `zinc` now reads `bg-idle` (neutral), as the task 02 note said.
- `Tag`: outlined label, neutral / `gcp` (aqua) / `aws` (amber).
- `Spark` and `sparkPaths`: the path maths of `Q.spark`, ported (viewBox 100x40, line plus 12% area, current colour).
- `StatCard`: the key-figure tile (card shape and shadow, 13px/700 label, 34px/800 figure, 13px foot). New optional
  `spark` prop; the tone colours the line. Without `spark` it renders as before apart from style.

**Deviation R15 (record in DESIGN-MAP):** the design's pills keep ink text on the tint. Here the word stays in the state's
text-grade colour (`text-state-*-fg`), because those pairs are contrast-tested at 4.5:1 in both themes and
`state-colours.test.tsx` pins the class names, and the glyph is added beside it. The glyph uses the same text-grade colour,
not the design's lighter glyph shade, for the same reason (the light shades are 3:1 on white). The mark inside a filled ring
is the surface colour, so no `--on-bad` / `--on-warn` tokens were needed.

**Tests changed on purpose**
- `state-colours.test.tsx`: the pill no longer has a `.bg-current` dot, it has an `aria-hidden` glyph svg (the word is still
  the pill's whole text). `zinc` is `bg-idle`.
- `ui-primitives.test.tsx`: the stat figure is 34px (was 32px) and the label is bold (was the `eyebrow` class).

**Ran, against what**
- `bun test packages/panel`: 1396 pass, 0 fail (208 files, 56 s). The new `ui-status.test.tsx` asserts each role has its own
  shape, completed/failed are filled and waiting is not, the Spark maths on a worked series and on a flat one, nothing drawn
  under two points, and exactly one `svg[aria-hidden]` on a `StatCard` only when `spark` is given.
- `bun run typecheck`, `bun run format:check`, `scripts/check-file-size.ts` (1553 files within 300 lines): clean. `bun run lint`:
  warnings only, in files this task did not touch.
- `bun run --cwd packages/panel build` ok; the compiled CSS contains each new utility (`ring-current/40`, `stroke-surface`,
  `bg-idle`, `text-hl`, `text-ok`, `text-bad`, `border-active/60`, `border-warn/60`).
- Screenshots of `/?demo` and `/jobs?demo`, dark and light, 1440x900, headless shell 1248. Pills show glyph plus word;
  Overview tiles show the 34px figure. Read by eye, not pixel-diffed.

**Not run:** `bun run architecture`, root `bun test`, Playwright e2e (task 16). No screenshot of `Spark` or `Tag` on a
page: no page uses them yet (tasks 08 to 13 do). `Spark` has no `StatCard` caller yet, so its look is judged from the CSS only.
