# 03 — Connected-language primitives

**Status:** done · **Depends on:** 01, 02 · **Touches:** packages/panel/src/components/ui/nodegraph, test
**Design:** https://claude.ai/artifact/TMMbZ97jDRzvSpWiFVKRuG, board "Connected language"

## Goal
Give `components/ui/nodegraph/` the pieces the boards use everywhere a relation is real: node, line, pill, rule glyphs and the rules hover card.

## Steps
1. Read the board and `components/ui/nodegraph/` (`NodeTile`, `Connector`, `nodeIcons.ts`) and `ruleChips()` in
   `pages/control/gateway/`. Reuse them: `NodeTile` is the node, `Connector` is the line.
2. `Connector`: add the draw-in (`motion-draw`) with a `delay` index, a state style that is not colour alone (solid, dashed for
   the two Paused states, dotted for Disabled, an arrow at the end), and a one-shot comet that a caller restarts by key.
3. New `ConnectionPill` (the connection's name and state glyph, a link) and `RuleGlyphs` (one small round glyph per editable
   rule that is on; a rule that is off draws nothing).
4. New `RulesCard` hover card: opens on hover or focus in 240ms, stays while the pointer is on it (a bridge above the card),
   leaves in 180ms through `usePresence`, Escape closes it, it lists all four editable rules on or off in the order an event
   meets them. It is an extra: on a phone a tap on the pill goes to the connection.
5. A vertical form under 720px: the line runs down from the source with each connection under it.
6. Tests: a state is its word and glyph first (never colour alone); the hover card opens on focus, closes on Escape and
   never traps focus; `RuleGlyphs` draws only the rules that are on; the comet class restarts on a key change and is absent
   on first render.

## Acceptance
- A line draws in once on first render and never loops. Lines carry no action; the pill is the link.
- Every state reads without colour: word, glyph, line pattern and node outline.
- The hover card is reachable by keyboard, closes on Escape, and is never the only way to see a rule.
- No colour value is hard-coded; all come from tokens. `accent-split-guard` and `design-rules-guard` pass.
- Existing users of `NodeTile` and `Connector` (flow graphs, Create page) render as before; their tests are unchanged.

## Verify
```bash
bun test packages/panel/test/nodegraph packages/panel/test/accent-split-guard.test.ts packages/panel/test/design-rules-guard.test.tsx && bun run typecheck && bun run lint && bun run format:check
```

## Risks / notes
- Rule glyph icons come from the existing icon set; no new icon dependency.
- The board draws lines with SVG and `scaleX`; the panel uses whichever `Connector` already uses, and says so in the Result.
- The board draws a connection row in HTML (a grid), so the row parts are HTML; the SVG `NodeTile` and `Connector` stay for canvases.

## Result
### What changed
- New in `components/ui/nodegraph/` (HTML, for rows and grids): `ConnectionNode` (icon in a tinted box, bold name, one line,
  outline by state, optional link, truncates with the full name in `title`), `ConnectionLine` (2px wire that runs into the 16px
  grid gaps, arrow, state pattern, `motion-draw` with an `index`, a one-shot comet keyed by `pulse`), `ConnectionPill` (link with
  the state glyph, named "{name}, {state word}"), `RuleGlyph` and `RuleGlyphs` (editable rules that are on), `HoverCard`
  (behaviour) and `ConnectionCard` (body), and `connectionState.tsx` (`ConnectionState`, `ConnectionGlyph`,
  `ConnectionStatus`, `wireStyle`, `WIRE_COLOUR`).
- `Connector` (SVG) gained optional `index` (draws in, once) and `dash`. Without them it renders as before.
- `src/lib/stagger.ts`: `stagger(i)` for the `--i` style, used by every page task.
- `motion.css`: `svg .motion-draw { transform-box: fill-box; }` so an SVG group scales about its own box.
- Test `test/nodegraph-connected.test.tsx` (12 tests). `NodeTile` is unchanged.

### Plan corrections (recorded, not silent)
- **HTML parts, not SVG.** Step 1 said `NodeTile` is the node and `Connector` the line. The board's rows are a CSS grid with
  truncating names, so the row parts are the new HTML `ConnectionNode` and `ConnectionLine`. The later tasks that draw rows
  (06, 08a, 08b, 10b, 11a, 12b, 13a, 13c) were reworded to use them. 11b keeps `NodeTile` and `Connector` for the flow canvas.
- **`RulesCard` is `HoverCard` plus `ConnectionCard`.** The board's card holds Open and a menu, so it must be reachable by Tab:
  it never moves focus, and Tab goes from the pill into the card and on. The caller passes `actions` (Open, menu) and the
  `fixed` phrases ("Retry, 8 attempts"), so the part holds no copy and imports nothing from `pages/`.
- **Close timing.** The board says 120ms after the pointer leaves and at once on Escape; both are done. Open is the
  `motion-drop` settle (300ms token), not the board's 240ms, so there is one enter time. Touch does not open it (G2).
- **Node tints.** The board has aqua, sun, mint and rose tints that are not tokens. No colour was added: source `slate-tint`,
  HTTP `state-active`, queue `state-waiting`, cron `state-completed`, other `state-delayed` (all existing pairs). Owner to
  confirm the look by eye.
- **Vertical form under 720px: not in the parts.** It is a property of the row's grid (the board only sets the row height
  and the link height), so it is done in task 06 where the grid is built. Deferred, not dropped.
- `held` and `paused` share a dashed line; they differ by glyph (bars, cross), word and outline colour.

### What ran
- `bun test packages/panel/test/nodegraph accent-split-guard design-rules-guard motion-guard ui-primitives-guard
  design-tokens flow-graph-page workflow-definition-graph`: 163 pass, 0 fail (happy-dom).
- `bun run typecheck`, `bun run lint` (exit 0; the existing warnings are unchanged), `bun run format:check`: clean.
- A lint error on the first `HoverCard` (a static element with handlers) was fixed with `role="presentation"`.

### Not run / by eye
- Nothing was rendered. Animation (draw, comet, drop, leave), the dashed and dotted patterns, the hover bridge and the card
  position on a narrow window are untested in a browser. The card is centred under the pill and can clip on a very narrow
  desktop window (`max-w` only).
