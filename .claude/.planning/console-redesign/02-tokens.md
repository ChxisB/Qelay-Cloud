# 02 — Tokens

**Status:** done · **Depends on:** 00 · **Touches:** packages/panel/src/index.css, packages/panel/test

## Goal
Remap the panel's colour, shape and focus tokens to the design's, so everything built on the existing roles re-skins.

## Steps
1. Read `qelay.css`'s two token blocks and `tokens.json`. Map each existing role to a design value: `--bg` paper,
   `--surface`, `--surface-2` raised, `--line`, `--line-strong` (field line), `--text`, `--text-muted` (ink-soft),
   `--text-faint` (ink-faint), `--primary` and `--primary-fg` (action and on-action), `--link` and `--ring` (coral),
   `--selected` (coral wash), `--success`, `--warning`, `--danger`, and every `--state-*` pair (ok, warn, bad, active, idle).
   Keep every name. Light values come from `[data-theme="light"]`.
2. Remap shape tokens: `--radius-card`, `--radius-control`, `--radius-segment`, `--radius-kbd` to the design's card,
   field, pill and key shapes.
3. Focus: one global rule for a 3px outline with a 3px offset on `:focus-visible`, in `--ring`.
4. Keep the brand gradient stops (`--brand-1..3`) for the mark and the one throughput chart. Keep the fluid root size.
5. Extend `test/design-tokens.test.ts` (it already parses `index.css` and has the contrast helpers; a second file would
   duplicate them) to assert WCAG contrast
   (4.5 for text pairs, 3 for UI edges) for text on bg, surface and surface-2, muted and faint text on the surfaces they
   are used on, `--primary-fg` on `--primary`, `--link` on bg and surface, each `--state-*-fg` on its `-bg` over surface,
   and `--ring` on bg.
6. Run the panel build and a screenshot of `/` in both themes. Read them against the board's colours.

## Acceptance
- Every token name that was in `index.css` is still defined in both themes (`design-tokens.test.ts` asserts the list).
- Every pair above meets its ratio in dark and light.
- `accent-split-guard` passes unchanged.
- No page file changed.

## Verify
```bash
bun test packages/panel/test/design-tokens.test.ts packages/panel/test/state-colours.test.tsx packages/panel/test/accent-split-guard.test.ts && bun run typecheck && bun run lint && bun run format:check
```

## Risks / notes
- A value the design gives that fails a ratio is adjusted here and the adjustment is written in the Result with its
  ratio, as the existing comments in `index.css` do. The design is not edited.
- Surfaces are now blue-grey, not navy. Charts and any hard-coded RGBA that assumed navy are found in tasks 08 to 13.

## Result
Done 2026-10-20. Changed `packages/panel/src/index.css` and `packages/panel/test/design-tokens.test.ts` only.

**What changed**
- Every existing token name is kept, in both themes. Values are now the Carebell ones: dark ground `#0e171f`, card
  `#16232e`, raised `#1f303d`; light ground `#e7edf3` with white cards (the design's two-tone surfaces). Primary is mint
  on forest in dark and forest on white in light. Links, focus and the selected-row wash are coral (`#ff9470` and
  `#ff865c` in dark, `#b8350f` and `#e9552b` in light). `color-scheme` is set per theme.
- New roles, registered in `@theme inline`: `ok warn bad active idle hl rose slate-tint danger-tint` (glyph, bar and
  chart colours). Not for text: the light glyph shades are 3:1 on white, not 4.5:1.
- Radii: card 28, control 14, segment pill, key 8. Fonts are untouched (task 01 is blocked).
- One global `:focus-visible` rule: 3px outline, 3px offset, `--ring`.
- `--line-strong` is the design's field line (`#7d8e9e`), so every existing `border-line-strong` control already clears 3:1.
- Job-state pills follow the design's status mapping: waiting is amber, prioritized coral, active aqua, completed green,
  failed red, delayed rose. This is a visible change for waiting (was grey) and delayed (was amber), see task 04.

**Adjusted from the design, with the numbers**
- Light text-grade shades, because the design's glyph shades fail 4.5:1 on white: success `#1b7a43` (4.55:1, design
  `#2da860` is 3.05:1), warning `#8a5b00` (5.87:1, design `#c8860b` is 3.06:1), active text `#0e766c` (5.49:1, design
  `#1fa594` is 3.06:1), delayed text `#a12a4b` (7.12:1). The design's own values stay as `--ok`, `--warn`, `--active`.
- Dark `--text-faint` is `#899cad`, not the board's `#8497a8` (4.31:1 on a selected row); light `--line-strong` is
  `#778898`, not `#7d8e9e` (2.86:1 on the grey ground). Both now pass on every surface and on the selected wash, and the
  tests check all of them (R22 in DESIGN-MAP.md; first written down as narrowed checks here, fixed in task 16).

**Ran, against what**
- `bun test packages/panel/test/design-tokens.test.ts state-colours.test.tsx accent-split-guard.test.ts`: 126 pass.
  Mutation check: loosening light `--line-strong` and `--ok` made exactly those two tests fail; restored.
- `bun test packages/panel`: 1378 pass, 0 fail (206 files, 56 s).
- `bun run typecheck` clean, `bun run format:check` clean, `bun run lint` exit 0 (react-hooks
  warnings in page files this task did not touch, for example `BackupOperationsPanel.tsx`, `QueueDetail.tsx`,
  `useDatabaseController.ts`).
- `bun run --cwd packages/panel build` ok. Screenshots of `/?demo` and `/jobs?demo`, dark and light, 1440x900, taken
  with the installed Chromium headless shell 1248 (Playwright 1.62.1 wants 1234, which is not installed; I did not
  download one, the disk has 1.1 GiB free). Read by eye against the board's CSS values, not pixel-diffed.

**Not run:** `bun run architecture` and the root `bun test` (only `packages/panel` changed, and `architecture`
checks other packages; both run in task 16). Playwright e2e (needs Postgres and the e2e runtime; task 16). 390px
screenshots (task 06 changes the shell first).

**Seen in the screenshots, for later tasks:** stat cards, section labels and the Queue health legend still have the old
layout and eyebrow style (tasks 03, 04); the Overview throughput card is still the brand gradient (task 08); the sidebar,
brand and top bar are still the old layout (task 06).

