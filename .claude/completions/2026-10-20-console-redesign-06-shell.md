# Console redesign 06: shell (2026-10-20)

Plan: `.claude/.planning/console-redesign/06-shell.md`. Panel only; no route, API, auth or capability change.

## Changed
- `packages/panel/src/components/layout/`: `navConfig.ts` (sentence-case labels, board icons), new `NavIcon.tsx`, `NavItem.tsx`, `NavGroup.tsx`, `Sidebar.tsx`,
  new `NodeSwitcher.tsx`, `ConnectionBadge.tsx` (health card), new `UserBlock.tsx`, `SidebarFooter.tsx`, `Breadcrumb.tsx` (`crumbsFor(path, root)`), `Topbar.tsx`.
- `components/brand/QelayLogo.tsx` (tile, "Qelay / Cloud console"); `ui/StatusBadge.tsx` (`StatusPill`/`StatusGlyph` take `state`; `StatusDot` restored); `ui/Button.tsx` (`iconButtonClass`); `index.css` (`--header-glass`).
- Tests: new `test/shell.test.tsx`; `nav-shell`, `brand-assets`, `nav-capabilities` and `e2e/dashboard.e2e.ts` changed by string only.

## Checked
Panel suite 1419 pass / 0 fail; typecheck, format:check and the file-size check clean; lint has no errors; panel build ok; `/jobs?demo` screenshots at 1440, 1024 and 390 (and the drawer) in both themes.
A top-bar wrap at 1024 was found in the screenshots and fixed.

## Owed or not run
Root `bun test`, `bun run architecture` and Playwright e2e run in task 16; the two e2e string edits were not executed. No real-browser keyboard walk of the drawer.
Deviations R7 (refined), R17, R18, R19 are in `DESIGN-MAP.md`: no nav counts, no bell badge, no top-bar live indicator, no active-row bar, group crumb kept.
