# 14 — Guards, docs and hand-off notes

**Status:** done · **Depends on:** 06, 07, 08a, 08b, 09, 10a, 10b, 11a, 11b, 12a, 12b, 13a, 13b, 13c, 13d · **Touches:** packages/panel/test, packages/panel/README.md, docs/PORTING.md, .claude/.planning/motion-redesign
**Design:** https://claude.ai/artifact/TMMbZ97jDRzvSpWiFVKRuG (all boards, for the README note only)

## Goal
Lock the new rules in with guards, empty the allowlists, and write the docs that say where the design came from.

## Steps
1. `test/motion-guard.test.ts`: the allowlist of raw durations from task 01 must now be empty. Remove it, and fail on any
   `duration-[`, raw `ms` value or `@keyframes` outside the token layer.
2. Add a guard that no `window.confirm` (or bare `confirm(`) is left in `packages/panel/src`, so the 27 sites cannot come back.
3. Add a guard that a `usePresence` user never keeps a node mounted past 180ms under reduced motion (reads `index.css` and
   `motion.css`: every `animation` and `transition` rule sits inside the no-preference query).
4. Confirm the existing guards still pass and need no loosening: `design-tokens`, `accent-split-guard`, `ui-primitives-guard`,
   `state-colours`, `brand-assets`, `design-rules-guard`, `fonts`, `brand-copy-guard`, `queue-settings-operations-hidden`, `mutation-action-guards`.
5. `packages/panel/README.md`: update "Look and feel" with the motion rules, the connected language, the approved tokens, the
   in-page confirm, and the canvas link and date (2026-10-22).
6. `docs/PORTING.md`: add one row under "Panel" for the motion redesign (the panel diverges from upstream on purpose, D8).
7. `DESIGN-MAP.md`: mark each deviation as built, skipped or changed, with the task that did it.
8. Keep `CURRENT.md`'s status table and every task's Result up to date.

## Acceptance
- Each new guard fails when you reintroduce what it forbids (try it once on a scratch edit and revert it; say so in the Result).
- The README and PORTING row exist and name the canvas link and date.
- Every numbered deviation in DESIGN-MAP.md has a line saying what happened to it.

## Verify
```bash
bun test packages/panel/test && bun run typecheck && bun run lint && bun run format:check && bun run architecture
```

## Risks / notes
- Docs must say Qelay, not bunqueue, and keep the MIT copyright line (`brand-copy-guard`, `legacy-name-guard`).
- Do not edit `docs/openapi.yaml` or anything outside the panel and the two docs named above.

## Result
Done 2026-10-22.

**Guards (all in `packages/panel/test`).**
- `motion-guard.test.ts` (258 lines): the raw-duration allowlist is gone and the test is `rawDurations(code) === []`. New: a
  time in any stylesheet must come from a token; every `animation` and `transition` in every `.css` file sits inside the
  no-preference query (keyframes, the reduce backstop and the `@utility ease-*` blocks are cut out first); and a presence user
  never holds a node past the exit time, or at all under reduced motion (only `usePresence.ts` and `useLeavers.ts` may name
  `EXIT_MS`, and both skip the wait when motion is reduced).
- `native-dialog-guard.test.ts` (new, 56 lines): no `window.`/`globalThis.` `confirm`, `prompt` or `alert`, and no bare call
  with a literal message, in `src`; and none stubbed or saved in `test`. It excludes itself.
- **Stub removal.** The 13 test files that saved and replaced `window.confirm` and `window.prompt` lost those lines (and three
  dead `realConfirm` exports). Nothing in `src` calls the browser's dialogs, so this changes no behaviour.

**Proof the guards fail.** Five scratch edits, each reverted (checked with `cmp`): `window.confirm` in `Card.tsx`; a
`duration-[250ms]` class in a TSX string; an unguarded `transition` appended to `index.css`; a raw `250ms` inside a
no-preference block in `motion.css`; and `usePresence` delaying by `EXIT_MS` under reduced motion. Each made the relevant guard
fail. After the restore both guard files showed 16 pass, 0 fail.

**Limit.** A bare `confirm(x)` whose argument is not a string or template literal is not caught: the pages have local helpers
named `confirm` and `alert` that take numbers (`useJobMutations.ts`, `ConnectionForm.tsx`), and they would be false hits. It is
a `shortcut:` comment in the guard; a lint rule on the global would close it.

**Docs.** `packages/panel/README.md` "Look and feel": the canvas link and date, the motion tokens and rules, the connected
language, the in-page confirm and the two new guards. `docs/PORTING.md`: one row under "Panel" (diverges on purpose, D8; no new
upstream code, `LICENSE` unchanged). `DESIGN-MAP.md`: a table with a line for every board's deviations (built, changed or not
built, and the task), and what is owed to the owner's word. `docs/openapi.yaml` is not touched.

**Stale spec, left alone.** `e2e/webhooks.e2e.ts:66` still waits for a native dialog (`page.once('dialog', ...)`). It targets the
Webhooks page, which `/events-gateway` replaced before this plan (HEAD still has the page; the working tree redirects it), so the
spec was already stale and cannot pass here. It is not edited and not run. It needs rewriting against the gateway pages and
`confirmInPage` (`answerQuestion` in `e2e/fixtures.ts` already does the latter); that is owed to task 15 or the owner.

**Ran.** `bun test packages/panel` from the repo root: 2092 pass, 0 fail, 291 files (125 s), so the 13 stub-edited files and
every existing guard (`design-tokens`, `accent-split-guard`, `ui-primitives-guard`, `state-colours`, `brand-assets`,
`design-rules-guard`, `fonts`, `brand-copy-guard`, `queue-settings-operations-hidden`, `mutation-action-guards`,
`legacy-name-guard`) pass unchanged. Root `bun run typecheck`, `bun run lint` (exit 0; the existing React-compiler warnings
only), `bun run format:check` and `bun run architecture` (1796 files within the 300-line cap) all pass.

**Not run.** The rest of the repo's `bun test` (Postgres and the other packages), e2e, the panel build, Docker, the panel in a
browser. Those are task 15.
