# 07 — Overlays

**Status:** done · **Depends on:** 03, 05 · **Touches:** packages/panel/src/components (CommandPalette, copilot/*), shared modal and drawer code, packages/panel/test

## Goal
Command palette, Copilot panel, confirm dialogs, drawers, modals and row menus match the Modals board, keeping their focus,
keyboard and dismissal behaviour.

## Steps
1. List every overlay in `src` (grep `role="dialog"`, `aria-modal`, `alertdialog`, `role="menu"`). Put the shared parts
   (scrim, panel, header, footer, focus handling) in one place if they are not already.
2. Command palette: search field with `Esc` key hint, grouped list (Pages, Actions, Jobs), selected row, footer with key
   hints and result count, "Nothing matches" empty state. Keep the `command-palette:open` event and ⌘K.
3. Copilot panel and `ConfirmCard`: drawer layout, message bubbles, suggestion chips, composer. Confirm cards keep their
   "changes always ask first" behaviour.
4. Confirm dialog with typed confirmation, form modal, picker, row menu with a destructive item and a separator.
5. Update the overlay tests that assert classes.

## Acceptance
- Each overlay still traps focus, closes on Escape, returns focus to its opener and has an accessible name (existing tests).
- A destructive confirm keeps its disabled-until-typed rule where the page had one.
- `bun run architecture` still passes (no broker names, no new imports across packages).

## Verify
```bash
bun test packages/panel && bun run typecheck && bun run lint && bun run format:check
```

## Risks / notes
- Overlays inside pages (modals in Cron, Webhooks, Database) are re-styled here only when they use the shared parts. A page
  with its own markup is finished in its page task.

## Result
Panel only; no route, API, auth or capability change.

**Built**
- Tokens `--raised` and `--scrim` (both themes). Every scrim now uses `bg-scrim`: palette, Copilot, row detail drawer, `AuthGate`, and the mobile nav from task 06 (no `bg-black/*` left in `src`).
- Command palette: `SearchField` with the `Esc` chip, grouped list (Pages, Actions) in the new `CommandPaletteList.tsx`, selected-row wash, key-hint footer with the result count, "Nothing matches" empty state. `command-palette:open`, ⌘K, the focus trap, isolation and the flat option ids (`command-palette-option-N`) are unchanged. `SearchField` now takes a `ref`; `Input` takes one too (`ComponentProps<'input'>`).
- Copilot: 580px drawer, "Ask Qelay" header with the "experimental" `Tag`, pill suggestion chips, `Button` composer, bubbles (user in `bg-primary`, assistant in `bg-slate-tint`), `ConfirmCard` on the waiting-state tokens with `Button` Confirm / Decline (same text, still asks first), the launcher and both fallbacks on the same tokens. The settings section moved to `CopilotConfig.tsx` to keep `CopilotPanel.tsx` under the file cap.
- Row detail drawer (Database page): scrim, 580px, round `iconButtonClass` close. `AuthGate`: `rounded-card` raised modal, `Input`, primary `Button`, 44px settings link.
- New `test/command-palette-groups.test.tsx` (3 tests: groups and ids, result count and filtering, empty state).

**Not built, and why**
- No Jobs group in the palette: the board's Jobs rows have no data source in the shell, and listing jobs there would add a request. Recorded as R20.
- Step 4 (confirm dialog with typed confirmation, form modal, picker, row menu): none of these components exist in `src` (grep for `alertdialog`, `role="menu"`, `<dialog` is empty). Destructive confirms use native `window.confirm`, which stays. The page forms (Cron, Webhooks) are page markup and are finished in their page tasks.

**Ran**
- `bun test packages/panel`: 1419 pass / 0 fail before the new test file; the new file passes on its own (3 tests); the full suite runs again in task 16.
- `bun run typecheck`, `bun run lint` (no errors), `bun run format:check`, the file-size check and `bun run architecture`: clean.
- Panel build ok. Screenshots with Playwright chromium against a `VITE_ENABLE_COPILOT=1` build in the scratchpad: palette (open, and filtered) and Copilot at 1440 and 390 in both themes, no page errors and no horizontal scroll.

**Not run**
- Playwright e2e, and a real-browser keyboard walk of the palette and Copilot. No screenshot of the row detail drawer or `AuthGate` (they need the Database page with data and a 401).
- Copilot on a short phone viewport with Settings open: the settings card sits above the scrolling messages and takes most of the height. It was already laid out that way; left as is.
