# 01 — Fonts

**Status:** done · **Depends on:** 00 · **Touches:** packages/panel/package.json, bun.lock, src/main.tsx, src/fonts.css, src/index.css

## Goal
Serve Plus Jakarta Sans and JetBrains Mono from the panel's own origin.

## Gate
A new dependency is a human gate. **Approved by the owner on 2026-10-20** ("Let's do it, add them to project"; both
fonts, through the packages). It was blocked until the user approved replacing `@fontsource-variable/inter` with
`@fontsource-variable/plus-jakarta-sans` and `@fontsource-variable/jetbrains-mono`. The alternative is vendoring woff2
files under `src/assets/fonts` with no dependency. Either way `font-src 'self'` already allows it, so `serve/server.ts`
and `vite.config.ts` need no change.

## Steps
1. After approval: `bun add --cwd packages/panel @fontsource-variable/plus-jakarta-sans @fontsource-variable/jetbrains-mono`
   and `bun remove --cwd packages/panel @fontsource-variable/inter`.
2. Replace the Inter import in `src/main.tsx` with the two new ones.
3. In `src/index.css` set `--font-sans: 'Plus Jakarta Sans Variable', ui-sans-serif, system-ui, sans-serif` and
   `--font-mono: 'JetBrains Mono Variable', ui-monospace, …`.
4. Add a test that the built CSS contains no `https://` font URL (the CSP would block it).

## Acceptance
- `bun run --cwd packages/panel build` output has the two font files and no external font request.
- `grep -rn "fonts.googleapis" packages/panel` finds nothing.
- The Inter package is gone from `package.json` and `bun.lock`.

## Verify
```bash
bun run --cwd packages/panel build && bun run typecheck && bun test packages/panel
```

## Risks / notes
- Nothing else waits on this. Tasks 02 to 15 use the existing stack, and this task changes two lines of the token file.
- Variable font file size: check the built asset sizes and say them in the Result.

## Result
Done, with the owner's approval of 2026-10-20.

**What changed**
- `packages/panel/package.json` and `bun.lock`: `@fontsource-variable/plus-jakarta-sans` and
  `@fontsource-variable/jetbrains-mono` (both `^5.3.0`, SIL OFL 1.1) added, `@fontsource-variable/inter` removed.
- `src/fonts.css` (new, imported by `main.tsx` before `index.css`): four hand-copied `@font-face` blocks, latin and
  latin-ext only, upright only. Deviation from Step 2: the packages' own CSS declares every script (cyrillic, greek,
  vietnamese, …), which would ship files the panel never uses, so only the two used subsets are declared. Every `url()`
  resolves into the installed package, so Vite emits same-origin files and `font-src 'self'` holds.
- `src/index.css`: `--font-sans` and `--font-mono` lead with the new families, system fallbacks kept.
  `src/vite-env.d.ts`: the Inter module declaration is gone.
- Tests: `test/fonts.test.ts` (new, 5 tests: deps and Inter gone; latin and latin-ext per family with the right weights,
  `swap` and `woff2-variations`; every url is a file the installed package ships and nothing is `http(s)://`; the stacks;
  no `cv11`/`ss01`). The Inter and system-mono tests left `design-tokens.test.ts`.
- Docs: panel README, `docs/PORTING.md` row, DESIGN-MAP R3.
- **Three selects widened**, because the wider face clipped their text on a phone (found by measuring, see below):
  `DlqProControls.tsx` Sort wrapper `w-36` → `w-44`, `LimitsCards.tsx` TTL cell `min-w-28` → `min-w-40`,
  `database/FilterBar.tsx` operator wrapper `w-32` → `w-36`.

**Built sizes** (Acceptance said "two font files"; it is four, one latin and one latin-ext per family): jetbrains-mono
latin-ext 15.19 kB, jetbrains-mono latin 40.40 kB, plus-jakarta-sans latin-ext 21.72 kB, plus-jakarta-sans latin 27.34 kB,
about 104 KB in all, against 132 KB for Inter. 0 `https://` in the built CSS; `grep -rn "fonts.googleapis\|fonts.gstatic"
packages/panel` finds nothing.

**What ran, and against what**
- Gate (scratch Postgres 18.6, `QCLOUD_REQUIRE_DB=1`): typecheck, lint, `format:check`, `architecture` all exit 0.
  `bun test`: 5174 pass, 252 skip, 1 fail. The one failure is `test/docs/release.test.ts` ("every package is MIT … carries a
  licence file"), which also fails at HEAD and is the owner's licence decision (see the completion doc). The workflow-model
  seed failure and the PG 18 read-plans failure from earlier gates did not recur on this run.
- `bun test packages/panel` from the root: 1527 pass, 0 fail before the width fixes; the full run above covers them.
  `docs:check` passed (its documented-commands step skipped: no database URL in that shell).
- Panel build passes. Headless Chromium against the built `dist` (preview server): both families report `loaded`, body, h1
  and `.font-mono` computed to the new families, and the page asked for exactly two woff2 files, both under `/assets`.
- Playwright e2e with axe, Chromium only, scratch Postgres: 35 passed.
- Route sweep, 43 routes × 2 themes × 2 widths = 172 renders: no horizontal scroll, one h1 each, no console errors.
  Screenshots of queues, jobs, logs, database and DLQ at 390 and 1440 were looked at: no wrapping or overflow problem.
- Clip sweep (light theme, 390 and 1440, every route): each visible `select`'s selected text measured against the room
  inside it. Three clipped (DLQ Sort at 390, queue-control TTL at both widths, database operator on a 1px margin); all three
  were widened and the sweep now reports 0 selects under 6px of slack. The cause is that these wrappers are in `rem`, which
  shrinks on a phone (the root size is fluid), while the select text is a fixed 15px.

**Did not run, or not covered**
- No automated guard for the select clipping: happy-dom has no layout, so a failing test could not be written first, and
  a class-string test would only assert the width. The check is the browser measurement above. A first guess (flex
  `shrink-0`) was wrong and was reverted. Moving this into a Playwright spec is the upgrade if it recurs.
- Not checked: whether the page-scoped label "Newest First (this page)" fits the DLQ Sort select. The sweep reported no clip,
  but I did not confirm that state was on screen. It was already longer than the old width.
- Firefox and WebKit e2e; Docker-backed and emulator suites; PG 16. No pixel diff against the boards.
