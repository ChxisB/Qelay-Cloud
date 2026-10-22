# 2026-10-20 — Console redesign, task 01: fonts

Approved by the owner on 2026-10-20 (a new dependency is a human gate). The full account, with what ran and what did not, is
the Result in `.claude/.planning/console-redesign/01-fonts.md`.

## Changed
- `packages/panel/package.json`, `bun.lock`: Plus Jakarta Sans and JetBrains Mono (`@fontsource-variable`, `^5.3.0`, SIL OFL
  1.1) in; Inter out.
- `packages/panel/src/fonts.css` (new): four `@font-face` blocks, latin and latin-ext, upright only, from the installed
  packages, so every file is same-origin under `font-src 'self'`. `src/index.css`: the two stacks. `src/vite-env.d.ts`: the
  Inter declaration removed.
- `packages/panel/test/fonts.test.ts` (new); `test/design-tokens.test.ts` lost its Inter and system-mono tests.
- Three selects widened because the wider face clipped them on a phone: `src/pages/control/dlq/DlqProControls.tsx` (Sort
  `w-36` → `w-44`), `src/pages/control/queue/LimitsCards.tsx` (TTL cell `min-w-28` → `min-w-40`),
  `src/pages/control/database/FilterBar.tsx` (operator `w-32` → `w-36`).
- Docs: panel README, `docs/PORTING.md`, DESIGN-MAP R3, the plan files.

## Checked
- Gate on scratch Postgres 18.6 with `QCLOUD_REQUIRE_DB=1`: typecheck, lint, format, architecture clean; `bun test` 5174 pass
  / 252 skip / 1 fail (`test/docs/release.test.ts`, which fails at HEAD too; a licence decision for the owner).
- Panel build: four woff2 files, about 104 KB (Inter was 132 KB), no `https://` in the built CSS.
- Headless Chromium on the built `dist`: both families load, two same-origin woff2 requests, no external host.
- e2e (axe, Chromium, scratch Postgres): 35 passed. Route sweep: 172 renders, 0 problems. Clip sweep: 0 selects under 6px of
  slack at 390 and 1440 after the three fixes.

## Owed or not run
- No automated guard for select clipping (happy-dom has no layout); the measurement was a one-off browser sweep.
- Not checked: the page-scoped DLQ sort label "Newest First (this page)".
- Firefox and WebKit e2e, Docker-backed and emulator suites, PG 16, a pixel diff against the boards.
