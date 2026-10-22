# 2026-10-20 — Console type scale: bigger, calmer text

Requested by the owner after seeing the demo ("Everything feels so compact, and large - so it's really hard to see"), who chose
"Bigger, calmer text" from the options. Also in this request: the sidebar's "Like it? Run it on your own server." card is gone,
because the console is served from someone else's server. Nothing is committed, pushed or published.

## Changed
- `packages/panel/src/index.css`: `--text-xs` 0.8125rem (13px) and `--text-sm` 0.9375rem (15px) in `@theme inline`;
  `.eyebrow` is 12px.
- `packages/panel/src/**/*.tsx|ts`: arbitrary text sizes +1px, `font-extrabold` → `font-bold`, `min-h-11` → `min-h-10`.
  `Button` is 40px (`IconButton` 40px, 32px with `size="sm"`).
- `SidebarFooter.tsx`: the install CTA is removed; `brand-copy-guard.test.ts` now asserts the footer carries no upstream link
  and no install pitch.
- Tests that pinned the old sizes were updated to the new values, none loosened: `design-tokens`, `ui-primitives`,
  `page-forms-12`, `page-forms-13`.
- Docs: DESIGN-MAP R25, the panel README "Look and feel", the console-redesign task 06 note.

## Checked
- Gate on a scratch Postgres 18.6 with `QCLOUD_REQUIRE_DB=1`: typecheck, lint, format, architecture clean; `bun test` 5174
  pass / 252 skip / 1 fail. The failure is `test/docs/release.test.ts` (the licence file still carries the upstream line), which
  fails at HEAD too and is a decision for the owner.
- e2e (Chromium, axe, scratch Postgres): 35 passed.
- Headless Chromium on the dev server, 43 routes at 390 and 1440 wide: no select short of room, no clipped button or table
  head; the 172 hits were two intentionally hidden (sr-only) elements. Route sweep: 172 renders, 0 problems (no horizontal
  scroll, one h1, no console errors).
- Looked at Overview, Queues and Jobs at 1440 and 1728, dark and light.

## Owed or not run
- Touch targets are 40px, where the boards say 44px (R25).
- Firefox and WebKit e2e; a pixel diff against the boards.
- The page-scoped DLQ sort label "Newest First (this page)" was not measured at 390.
- `bunx playwright` picks a Chromium revision that is not installed here; the e2e ran through the package's own binary and a
  scratch config pointing at the installed Chromium (the config was deleted).
