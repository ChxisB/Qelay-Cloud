# 02 — Motion primitives

**Status:** done · **Depends on:** 01 · **Touches:** packages/panel/src/motion.css (new), src/index.css, src/lib, test
**Design:** https://claude.ai/artifact/TMMbZ97jDRzvSpWiFVKRuG, boards "Motion" and "Shell and overlays" (presence hook)

## Goal
Build the few patterns every screen uses (arrive, leave, stagger, change flash, draw, fill, pop, presence) once, so a page task adds a class and not a keyframe.

## Steps
1. Add `src/motion.css`, imported by `index.css`. Every rule that moves sits inside
   `@media (prefers-reduced-motion: no-preference)`. Only `transform` and `opacity` move. Utilities, named as the Motion board
   names them: `motion-arrive` (rise 8px as the board's q-arrive has it, and fade, `--dur-enter`, `--ease-settle`), `motion-leave` (`--dur-exit`,
   `--ease-exit`), `motion-stagger` (delay from `--i`, capped at 8 items, `--dur-stagger`), `motion-flash` (a one-shot wash on a
   changed figure), `motion-draw` (`scaleX` 0 to 1 from the left, `--dur-draw`), `motion-fill` (a bar's `scaleX`),
   `motion-comet` (one pass along a line, `--dur-flow`) and `motion-pop` (`--ease-pop`, small switches and the lock card only).
2. `src/lib/usePresence.ts` (about fifteen lines): `usePresence(open)` returns `{ mounted, leaving }`; a leaving surface stays
   mounted for `--dur-exit` (read from the token, 180ms) and unmounts at once under reduced motion. It never holds focus or
   blocks input.
3. `src/lib/useChangeFlash.ts`: `useChangeFlash(value)` returns a `key` that changes only when a polled value changes after
   the first read, so the flash restarts by React key and an unchanged poll does nothing. Equal values, the first render and
   a remount do not flash.
4. Tests with `happy-dom` assert end state and hooks, not timing (it has no animations): `usePresence` mounts, leaves and
   unmounts with fake timers and unmounts at once when `matchMedia('(prefers-reduced-motion: reduce)')` matches;
   `useChangeFlash` flashes on a change, not on the first read or an equal value.
5. Turn on the guard's `motion.css` rules from task 01 and remove the allowlist entries this file replaces, if any.

## Acceptance
- Each utility exists in `motion.css`, inside the no-preference media query, and uses only the task 01 tokens and
  `transform` or `opacity`.
- `usePresence` keeps a surface mounted for 180ms, then unmounts; under reduced motion it unmounts at once.
- `useChangeFlash` does not flash on the first read, on an equal value or on a remount, and does on a real change.
- `motion-guard.test.ts` passes with the `motion.css` rules switched on.
- No page file changed.

## Verify
```bash
bun test packages/panel/test/motion-guard.test.ts packages/panel/test/usePresence.test.tsx packages/panel/test/useChangeFlash.test.tsx && bun run typecheck && bun run lint && bun run format:check
```

## Risks / notes
- A page-wide stagger on 1000 rows would take seconds: the cap at 8 is in the CSS, not left to each caller.
- The comet is a one-shot class a caller adds on a key; it must never loop.
- Route transition (`viewTransition`) is wired in task 04a, where the links live.

## Result
Added `src/motion.css` (imported by `index.css`), `src/lib/usePresence.ts`, `src/lib/useChangeFlash.ts`, and tests
`usePresence.test.tsx`, `useChangeFlash.test.tsx`; `motion-guard.test.ts` now has `motion.css` switched on (no skip).
- Utilities: `motion-arrive`, `motion-stagger` (children, delay from `--i`, capped at 8), `motion-leave`, `motion-draw`,
  `motion-fill` (draws in once, then a `transform` transition), `motion-flash`, `motion-comet`, `motion-pop`; plus
  `motion-fade`, `motion-drop`, `motion-slide` for the scrim, dialog or menu and drawer that task 04b needs, so that task adds
  a class and not a keyframe. All inside the no-preference query; keyframes carry only the start (or the end for leave), so an
  element keeps its own `transform` (a centred card, a bar's `scaleX`).
- Deviation from the plan text: the rise is 8px, as the board's q-arrive has it (the plan said 12px).
- `usePresence` unmounts in the render itself under reduced motion; it reads `matchMedia` each render and sets state in render,
  not in an effect (the effect form added a `react(set-state-in-effect)` lint warning).
- Guard additions: motion.css names all eight patterns and its keyframes move only `transform` and `opacity`; `EXIT_MS` in
  `usePresence.ts` equals `--dur-exit`. Checked by planting a `width` in a keyframe and an unguarded `transition` (2 tests
  failed) and an `EXIT_MS` of 200 (1 failed), then restored.
- Ran: the three test files (21 pass), `bun run typecheck`, `bun run lint` (exit 0; no warning from the new files),
  `bun run format:check`. Not run: anything in a browser (nothing uses the classes yet); the full gate (task 15).
