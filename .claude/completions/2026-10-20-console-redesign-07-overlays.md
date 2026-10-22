# Console redesign 07: overlays (2026-10-20)

Plan: `.claude/.planning/console-redesign/07-overlays.md`. Panel only; no route, API, auth or capability change.

## Changed
- `packages/panel/src/index.css`: `--raised`, `--scrim`. `components/ui/SearchField.tsx` and `ui/form.tsx` (`Input`) take a `ref`.
- `components/CommandPalette.tsx`, new `CommandPaletteList.tsx` (groups, footer, empty state).
- `components/copilot/`: `Copilot.tsx` (launcher, fallbacks), `CopilotPanel.tsx`, `CopilotPanelParts.tsx` (`ConfirmCard`, bubbles), new `CopilotConfig.tsx` (settings section moved out).
- `components/AuthGate.tsx`, `components/layout/Sidebar.tsx` (scrim only), `pages/control/database/RowDetailDrawer.tsx`.
- Tests: new `test/command-palette-groups.test.tsx`; no existing test needed a change.

## Checked
Panel suite 1419 pass / 0 fail (before the new test file; the new file's 3 tests pass alone); typecheck, lint (no errors), format:check, file-size and architecture clean; panel build ok.
Screenshots of the palette and Copilot at 1440 and 390 in both themes, from a `VITE_ENABLE_COPILOT=1` build kept in the scratchpad (the Copilot is off in the default build).

## Owed or not run
Playwright e2e and a keyboard walk in a real browser; no screenshots of the row detail drawer or `AuthGate`.
Deviation R20 (no Jobs group in the palette) is in `DESIGN-MAP.md`. No confirm dialog, form modal, picker or row menu component exists in `src`, so none was restyled; native `window.confirm` stays.
