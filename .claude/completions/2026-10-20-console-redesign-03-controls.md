# Console redesign, task 03: controls, cards, page header

Plan: [.claude/.planning/console-redesign/CURRENT.md](../.planning/console-redesign/CURRENT.md). Task file: [03-controls.md](../.planning/console-redesign/03-controls.md).

## Changed
- `packages/panel/src/components/ui/`: `Button.tsx` (pill, 44px, `IconButton` circle with `size="sm"`), `form.tsx` (48px
  fields, `Field` `error` prop with `aria-invalid`/`aria-describedby`, the design's switch and segmented control),
  `SearchField.tsx`, `Kbd.tsx`, `Pagination.tsx` (Button pills), `Card.tsx`, `PageHeader.tsx`. One class swapped in
  `CopyButton.tsx` and `feedback.tsx` (3px outline) because one a11y test covers them with the controls.
- `packages/panel/src/index.css`: `--on-ok`, `--panel-shadow` (registered as `--color-on-ok`, `--shadow-panel`).
- Tests: `ui-primitives`, `ui-components-a11y`, `ui-primitives-guard`, `design-tokens` updated; new `ui-form-controls`.

## Checked
- `bun test packages/panel`: 1389 pass. Typecheck, format, lint (exit 0), file-size script and panel build ok.
- Screenshots of `/settings`, `/queues`, `/add-job` in dark and light, read by eye. Not pixel-diffed.

## Owed or not run
- Visible change to note: `IconButton` now defaults to the bordered variant at 44px; table pages decide `size="sm"` in 08 to 13.
- `Toggle` on-state is covered by a unit test only (no sampled page had an on switch).
- `bun run architecture` (other checks), root `bun test`, Playwright e2e: task 16. Fonts (task 01) stay blocked.
