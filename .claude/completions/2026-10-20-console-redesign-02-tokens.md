# Console redesign, task 02: tokens

Plan: [.claude/.planning/console-redesign/CURRENT.md](../.planning/console-redesign/CURRENT.md). Task file: [02-tokens.md](../.planning/console-redesign/02-tokens.md).

## Changed
- `packages/panel/src/index.css`: Carebell values for every existing colour role in both themes, nine new status roles
  (`ok warn bad active idle hl rose slate-tint danger-tint`) registered in `@theme inline`, radii (card 28, control 14,
  segment pill, key 8), per-theme `color-scheme`, one global 3px `:focus-visible` ring.
- `packages/panel/test/design-tokens.test.ts`: contrast tests for the new palette (text, selected row, field line,
  glyphs, primary, ring, state pills), a core-roles-still-defined test, the new radii and the focus rule.

## Checked
- `bun test packages/panel`: 1378 pass. Typecheck, format and lint (0 errors) clean. Panel build ok.
- Dark and light screenshots of `/?demo` and `/jobs?demo`, read by eye. No pixel diff exists (the design boards cannot be
  rendered locally).

## Owed or not run
- `bun run architecture`, root `bun test`, Playwright e2e: task 16.
- Fonts (task 01) stay blocked on the dependency approval.
