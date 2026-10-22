# 04 — One System page

**Status:** done · **Depends on:** 01 · **Touches:** packages/panel

## Goal
Server, Database, Backups (S3), MCP, Benchmark and Fleet are tabs of one "System" page, `/system`. Settings stays its own
page (connections, credentials, appearance).

## Steps
1. New `/system` route with tabs (`?tab=server|database|backups|mcp|benchmark|fleet`), each rendering the existing page body.
2. Redirects: `/server`, `/database`, `/s3`, `/mcp`, `/benchmark`, `/fleet`. Capability gating per tab as in task 03
   (`s3Backup` hides Backups, server-control hides Server).
3. Fleet is the multi-node view; it keeps its own capability rule.

## Acceptance
- Six old paths redirect to the right tab (test); a closed feature hides its tab (test).
- Benchmark still refuses to touch real queues (existing test passes).

## Verify
```bash
bun run typecheck && bun test packages/panel
```

## Risks / notes
- Benchmark and Server hold destructive or load-generating actions: keep their guards (`useServerActionGuard`) as they are.

## Result

### Plan correction
Same as task 03: no `/system` route and no six redirects. The six pages keep their paths and a tab bar (`SystemTabs` over
`SectionTabs`) on each links the others; the sidebar has one **System** item (the first path of `SYSTEM_TABS`, the rest in
`also`). Reasons are in task 03's Result. The URL stays `/server`, `/database`, `/s3`, `/mcp`, `/benchmark`, `/fleet`.
"Capability gating per tab" is real here and needs no new code: `SectionTabs` leaves out a path `isPageAvailable` closes
(`serverControl`, `sqliteDatabase`, `s3Backup`, `fleet` hidden; Benchmark is operator-only), and `visibleNav` links System to
the first page that is open and drops the item when none is.
"Backups" is the tab label for the S3 page (`/s3`); Settings stays its own item, as the plan says.

### Parity
No page lost an action: only a tab bar was added under each header. Benchmark's real-queue refusal and the Server and Benchmark
action guards are untouched (their tests pass, mounted under a router).

### What changed
- `navConfig.ts`: `SYSTEM_TABS`; System replaces Server, Benchmark, Database, MCP, S3 backup and Fleet. The nav is now **14
  items**, which is the task 05 target; sections are unchanged until task 05 (Control holds only Webhooks for now).
- `components/SystemTabs.tsx`; `<SystemTabs>` under every header of the six pages (three on `ServerControl`: its error,
  loading and ready states).
- `NavIcon.tsx` loses the five icons nothing uses.
- Tests: new `system-tabs.test.tsx` (tab bar, a closed page is left out, a viewer loses Benchmark and a lone page is not a
  switch, one sidebar link current on all six); `shell`, `nav-shell`, `nav-capabilities` pins; 15 test files that mounted a page
  without a router now wrap it in `MemoryRouter`.
- e2e `dashboard`: the sidebar must carry Health (`/deployment`) and System (`/mcp` on this deployment); the link-count floor
  went from 15 to 10 because the nav now has 14 items at most. That is the only count the e2e pinned.

### What ran
`typecheck` (with the e2e project), `lint`, `format:check`, `architecture`, `bun test packages/panel` from the repo root (1561
pass, 0 fail). **Not run:** Playwright e2e; the clip sweeps at 390 and 1440 (a tab bar was added to six pages).

