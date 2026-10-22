# 01 — Motion tokens and guard

**Status:** done · **Depends on:** none · **Touches:** packages/panel/src/tokens.css, src/index.css, test
**Design:** https://claude.ai/artifact/TMMbZ97jDRzvSpWiFVKRuG, board "Motion"

## Goal
Define the shared durations and easings once, keep the reduced-motion backstop, and add a guard so later tasks cannot drift.

## Steps
1. Read the "Motion" board and `qmotion.css` (a board file: take values, not code). Add the approved non-colour tokens to
   `src/tokens.css` in one `:root` block that sits outside the two theme blocks (no light and dark pair):
   `--duration-press` 160ms, `--duration-hover` 240ms, `--dur-enter` 300ms, `--dur-exit` 180ms, `--dur-stagger` 40ms,
   `--dur-draw` 600ms, `--dur-flow` 900ms, `--ease-settle` `cubic-bezier(.22,1,.36,1)`, `--ease-exit`
   `cubic-bezier(.4,0,1,1)`, `--ease-pop` `cubic-bezier(.34,1.56,.64,1)`.
2. Add `ease-settle`, `ease-exit` and `ease-pop` to `src/index.css` as three `@utility` blocks that read the tokens (a
   same-name `@theme inline` mapping would point `--ease-settle` at itself). Durations are used as `duration-(--duration-press)`; Tailwind has no duration theme namespace, so no mapping.
3. Leave the `prefers-reduced-motion: reduce` rule at the foot of `index.css` exactly as it is. It is the backstop for
   everything the later tasks add.
4. Add `test/motion-guard.test.ts`, in the style of `ui-primitives-guard.test.ts` (a small pure function per rule, run over
   the source lines, with a planted bad line proving each rule fails):
   - the ten tokens exist, once, with the approved values, outside the theme blocks;
   - the reduce rule is still in `index.css`;
   - no arbitrary duration (`duration-[…]`) and no raw millisecond value in a `style` prop or an inline `transition` or
     `animation`, outside `src/motion.css` once task 02 creates it;
   - `@keyframes` appear only in `src/motion.css` (`index.css` has none today);
   - every rule in `src/motion.css` that sets `animation` or `transition` sits inside
     `@media (prefers-reduced-motion: no-preference)` (the test skips this rule while the file does not exist).
5. Count the `transition-*` and `duration-*` uses that exist today and put the existing raw ones in an allowlist in the test,
   so the guard fails on a new one and the later tasks shrink the list.

## Acceptance
- The ten tokens are defined once, with the approved values, and apply in dark and light (`design-tokens.test.ts` still passes).
- `ease-settle`, `ease-exit` and `ease-pop` exist as utilities (a test reads the built CSS or the `@theme` block).
- The guard fails on a planted raw duration, a stray `@keyframes` and an unguarded animation, and passes on the tree.
- The `prefers-reduced-motion: reduce` rule is unchanged.
- No page or component file changed.

## Verify
```bash
bun test packages/panel/test/motion-guard.test.ts packages/panel/test/design-tokens.test.ts packages/panel/test/ui-primitives-guard.test.ts && bun run typecheck && bun run lint && bun run format:check
```

## Risks / notes
- The guard's allowlist is a debt list. It only shrinks; task 15 asserts it is empty or says why not.
- Tailwind scans `test/` too. Assemble any class name the guard mentions from parts, as the other guards do.

## Result
Done 2026-10-22.
- **Changed:** `packages/panel/src/tokens.css` (one `:root` block after the light block, ten tokens), `src/index.css` (three
  `@utility ease-*` blocks; the reduce rule is untouched), new `test/motion-guard.test.ts` (10 tests, 187 lines).
- **Guard:** token values and placement (once, after both theme blocks); the easing utilities; the reduce rule; raw durations
  (`duration-<n>`, `duration-[…]`, a time in a style prop or an inline transition or animation); `@keyframes` only in
  `src/motion.css`; `animation` and `transition` in `motion.css` only inside the no-preference query (skipped while the file
  does not exist; the rule itself is tested on a planted string).
- **Allowlist (debt):** `src/components/layout/NavGroup.tsx` (`duration-150`). Task 04a removes it; task 14 asserts the list is
  empty. The allowlist test fails if a listed file stops needing it.
- **Ran:** `bun test packages/panel/test/motion-guard.test.ts packages/panel/test/design-tokens.test.ts
  packages/panel/test/ui-primitives-guard.test.ts` — 125 pass, 0 fail. `bun run typecheck` clean, `bun run lint` exit 0 (only
  warnings that were there before), `bun run format:check` clean after `oxfmt` on the new test.
- **Proved the guard bites:** planted a raw duration, a stray `@keyframes`, a changed token value and a removed reduce-rule
  line; each made exactly one guard test fail; files restored and byte-compared.
- **Not run:** the full gate and the panel build (not needed for a token-only change; task 15 runs them).
