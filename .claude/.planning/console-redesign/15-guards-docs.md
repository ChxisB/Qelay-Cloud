# 15 — Guards, docs, porting row

**Status:** done · **Depends on:** 09, 10, 11, 12, 13, 14 · **Touches:** packages/panel/test (accent-split-guard, brand-assets, brand-copy-guard), docs/PORTING.md, packages/panel/README or docs

## Goal
The guards describe the new design, not the old one, and the docs say what the panel now looks like.

## Steps
1. Re-run the three guards. Where a guard encodes the old look (not a real rule), change it deliberately and say why in
   the Result. A guard that encodes a real rule (accessible focus, no colour-only status, footer repo link) stays as it is.
2. Add a guard for the new rules: every `-accent` token stays banned, focus ring is the 3px outline, status glyph beside
   every status word (a render-based test over the shared components).
3. `docs/PORTING.md`: a row under "Panel, Changed" for the redesign, with the deviation list R1 to R14 summarised.
4. Panel README or docs: one section on the design source, the token file as the place to change colour, and the font
   state (task 01).
5. `bun run docs:check` if any doc the checker reads changed.

## Acceptance
- No guard was loosened to pass. Each changed guard has a one-line reason in the Result.
- The PORTING row exists and names the artifact and date.
- `bun run docs:check` passes (or is stated as not applicable).

## Verify
```bash
bun test packages/panel && bun run docs:check && bun run typecheck && bun run lint && bun run format:check
```

## Risks / notes
- The upstream MIT notice stays in every ported file. The redesign adds no upstream code, so no new notice is needed, but the
  PORTING row says so.

## Result

**Guards re-run** (accent-split, brand-assets, brand-copy, ui-primitives, state-colours, legacy-name): 53 pass before any edit here. No guard was loosened.
- `ui-primitives-guard`: changed in task 03 and 05, not here. The radii comment names the new shapes (card 28, field 14, pill buttons) and the `rounded-md` allowlist **shrank** from three files to one, because Pagination and the feedback retry now use the Button pill.
- `brand-assets`: the `QelayLogo` subtitle expects "Cloud console" (task 06 copy). The rule (mark, wordmark, one svg) is unchanged.
- `accent-split-guard`: wording only. The white-text rule stays, but its reason was stale ("orange fill, 2.61:1"). `primary` is dark green in light and pale mint in dark, so fixed white text fails in dark. The test is now named for that.
- `brand-copy-guard`: untouched. The footer repo link, the assistant sentence and the legacy-name list still hold.

**Added:** `test/design-rules-guard.test.tsx` (4 tests).
- No element opts out of the global 3px focus outline (`focus:outline-none` and `focus-visible:outline-none` banned in `src`); a bare input `outline-none` is allowed only in SearchField, LogSearch and NodeSwitcher, whose wrapper draws the same 3px ring (checked in the file).
- The six state glyphs render six different shapes (colour is never the only difference), and each is `aria-hidden` and not focusable.
- Not duplicated, because a test already holds them: every `-accent` token banned (`accent-split-guard`), the CSS `:focus-visible` rule is 3px (`design-tokens`), every mapped status renders glyph and word (`state-colours`).

**Source fix the new guard found:** three links on the `*-classic` queue pages used `focus-visible:outline-none focus-visible:ring-2` (a 2px ring in place of the 3px outline): `Queues.tsx` (queue name) and `QueueDetail.tsx` (back link, job id). The three class strings were removed, so the global outline applies. No other change to those pages.

**Docs:** `docs/PORTING.md` has a row under "Panel, Changed" (artifact URL, 2026-10-20, no upstream code so no new notice, R1 to R21 summarised, the font gap said plainly). `packages/panel/README.md` has a "Look and feel" section: design source, the token file as the place to change colour, shapes and focus, the guards, and the font state.

**Ran**
- `bun test packages/panel`: 1516 pass, 0 fail (221 files). typecheck, lint, `format:check` (1558 files), `architecture`: exit 0. `git diff` of `shared/` and `src/lib/auth/`: empty.
- `bun run docs:check`: generated docs current, 594 links resolve, command blocks, imports and the config reference all ok.

**Not run:** `docs:check`'s "documented commands run" step (skipped with a warning: Postgres is down). Not applicable to this change, which edits no command block.

**Residual, not fixed:** two hand-rolled pills (`pages/Queues.tsx` Paused/Active, `pages/control/overview/OverviewHeader.tsx` Live/Paused) use a plain dot and a word on a state tint, not `StatusPill`. They carry the word, so they are not colour-only, but they have no per-state glyph. Moving them onto `StatusPill` would change the Overview header look; left for the owner.
