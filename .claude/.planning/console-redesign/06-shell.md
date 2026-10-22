# 06 — Shell

**Status:** done · **Depends on:** 03, 04 · **Touches:** packages/panel/src/components/layout, src/components/brand/QelayLogo.tsx, src/components/ui/icons.tsx, packages/panel/test, packages/panel/e2e

## Goal
Sidebar, brand lockup, profile switcher, nav, health card, user block, top bar and breadcrumbs match the Main board, and
the mobile drawer, focus trap and every shell behaviour in `AppLayout` are unchanged.

## Steps
1. `navConfig.ts`: sentence-case labels (R10) and the board's icon paths. `NAV`, `visibleNav` and `locateNav` keep their shape.
   `locateNav` still returns the section name; the section label is shown as the design's small group label.
2. `QelayLogo`: tile (R2) plus the words "Qelay" and "Cloud console". `QelayMark` is not changed.
3. `Sidebar`, `NavGroup`, `NavItem`: 264px column, group labels, coral-wash active row with the 3px bar, optional count
   badge (R7). Groups stay collapsible disclosures, because `useNavGroups` and its tests depend on it.
4. `ConnectionBadge` → the profile switcher and health card (R4, R6). Keep the `Active node` select, its label and its
   15 s poll. Check `/ready` first; show only facts the payload carries.
5. `SidebarFooter` → user block (R5). Role from the capabilities store, subject from the auth store when managed,
   `Sign out` inside it when managed. Demo CTA stayed, restyled; removed on 2026-10-20 at the owner's request (the demo is hosted by others, so "run it on your own server" does not apply).
6. `Topbar`: crumbs, a live indicator tied to the existing poll, the palette trigger styled as the search field (R8),
   theme toggle (R9), alerts bell with a badge from the alert store, menu button below `lg`.
7. `Breadcrumb`: root crumb is the active profile name (R4).
8. Update `nav-shell.test.tsx`, `brand-copy-guard` (theme toggle location), `frontend-a11y-fixes`, the 18 other test files
   that name old labels, and the 8 e2e files. Each edit changes an expected string to the board's, nothing is loosened.

## Acceptance
- Labels and order equal `qnav.js`'s groups with the panel's own routes. A test compares the two lists by route.
- Mobile drawer: opens, traps focus, closes on Escape and on route change, restores focus to the opener (existing
  `AppLayout` tests pass unchanged).
- Skip link and landmarks (`complementary`, `Primary` nav, `Breadcrumb` nav) are all still present.
- The user block shows no name the stores do not hold; with no session it shows the role only.
- `Sign out` is reachable by keyboard when sign-in is managed and absent otherwise.
- The theme toggle's label names the mode you switch to.

## Verify
```bash
bun test packages/panel/test/nav-shell.test.tsx packages/panel/test/brand-copy-guard.test.ts packages/panel/test/brand-assets.test.tsx && bun test packages/panel && bun run typecheck && bun run lint && bun run format:check
```

## Risks / notes
- This is the widest test ripple in the plan. Edit tests by string, run them by file, then the whole panel suite.
- The shell is on every page, so a contrast or layout error here shows everywhere. Screenshot `/` at 1440, 1024 and 390
  in both themes.

## Result
Done 2026-10-20. Panel only; no route, API, auth or capability logic changed.

**Changed**
- `navConfig.ts` (R10 labels, the board's icon paths), new `NavIcon.tsx` (30 board icons plus sun, moon, menu, search, chevrons, sign-out), `NavItem.tsx` (pill row, coral wash, `--hl` icon),
  `NavGroup.tsx` (root group labelled "Console"; labelled groups stay disclosures with `aria-expanded`/`aria-controls`, an item count when collapsed, a rotating chevron).
- `QelayLogo.tsx` (R2 tile, "Qelay" and "Cloud console"), new `NodeSwitcher.tsx` (the `.org` pill over the same native "Active node" select), `ConnectionBadge.tsx` (health card with rings, `StatusPill`),
  new `UserBlock.tsx`, `SidebarFooter.tsx`, `Sidebar.tsx`, `Breadcrumb.tsx` (`crumbsFor(path, root)`, root is the active profile name), `Topbar.tsx` (glass bar, palette trigger as the search field, theme toggle, Alerts link, menu button below `lg`).
- `StatusBadge.tsx`: `StatusPill` and `StatusGlyph` take a `state` prop (a `role` prop trips `jsx-a11y/aria-role` on a literal); `StatusDot` restored (it had been dropped from the file).
  `Button.tsx`: `iconButtonClass`. `index.css`: `--header-glass`.
- Tests by string only: `nav-shell` (labels, `crumbsFor` root, active row has no bar, theme test moved), `brand-assets`, `nav-capabilities`, `e2e/dashboard.e2e.ts` ('Cron jobs', twice). New `test/shell.test.tsx`: nav groups, order and labels against a literal table copied from `qnav.js`,
  icon and route uniqueness, landmarks, breadcrumb root, theme toggle label, `UserBlock` (role only when signed out, subject and keyboard-reachable Sign out when managed and ready, none otherwise).
- The 30 icon paths in `NavIcon.tsx` were compared with `qnav.js` by script: all equal.

**Ran, against what**
- `bun test packages/panel`: 1419 pass, 0 fail, 210 files (happy-dom). `bun run typecheck`, `bun run format:check`, `scripts/check-file-size.ts`: clean. `bun run lint`: no errors; the warnings are in files this task did not touch.
- `bun run --cwd packages/panel build`: ok. Screenshots of `/jobs?demo` from the built preview at 1440, 1024 and 390 (plus the open drawer) in dark and light, read by eye; no page error and no horizontal scroll at any size.
  The 1024 shot showed the top bar wrapping the bell onto a second row; fixed (search shrinks, "Live demo" chip from `md`) and re-shot.

**Not run**
- Playwright e2e (task 16). The e2e edits are two strings and were not executed. No keyboard walk of the drawer in a real browser: the focus trap in `AppLayout` is untouched and its tests pass.
- No `/ready` payload richer than a disk-full flag exists, so the health card states only the Control API state and node host (R6 stands).

**Deviations** R7 refined, R17 to R19 in `DESIGN-MAP.md`.
