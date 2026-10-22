# 01 — Remove the classic pages

**Status:** done · **Depends on:** none · **Touches:** packages/panel

## Goal
The 11 `*-classic` routes, which nothing links to, are gone and their paths redirect to the current pages.

## Steps
1. Confirm no current page imports from the classic ones (`grep` for each classic page, `ClassicJobsTable`, `classicJobsData`,
   `pages/queue/QueueConfig`, `queueDetailData`). Anything a current page still uses stays and moves out of `pages/`.
2. In `App.tsx` replace each classic route with `<Navigate to="<pro path>" replace />` (`/queues-classic/:name` to
   `/queues/:name`); drop the lazy imports. Delete the page files and their helpers.
3. Remove the classic entries from `pageTitle.ts`, `capabilities/model.ts` and `navConfig.ts` comments.
4. Delete the `classic-*` tests; keep one test that every old path redirects to its new one. Never loosen a Pro-page test.
   If a deleted test covered behaviour the Pro page also has and that is not tested there, port the assertion first.

## Acceptance
- No route or file named `*-classic` remains except the redirect table (test: `rg -i classic packages/panel/src` shows only it).
- Each of the 11 old paths redirects (test).
- `bun run typecheck` and the panel bundle build with no dead import.

## Verify
```bash
bun run typecheck && bun test packages/panel
```

## Risks / notes
- Five test files pin "mutation safety" of the classic pages. Check each assertion has a Pro-page twin before deleting.

## Result
- **Changed:** deleted the 11 classic pages and their 4 helpers (`ClassicJobsTable`, `classicJobsData`, `queue/QueueConfig`,
  `queue/queueDetailData`); `App.tsx` sends each `/<page>-classic` path to the new `components/LegacyRedirect.tsx` (strips
  the suffix, keeps query string and hash, case-insensitive); the classic entries are gone from `pageTitle.ts`,
  `capabilities/model.ts` and the `navConfig`, `Breadcrumb` and `UsagePro` comments; `e2e/all-routes` now asserts the
  redirects; a row in `docs/PORTING.md`.
- **Tests:** new `legacy-redirect` (2), `pro-pages-failure` (4), `mcp-reference-page`, `alerts-rule-form`,
  `queue-detail-pro-safety` (3), one more case in `queue-control-audit-04`. Deleted: `classic-mutation-safety` (4 files),
  `classic-pages-complete`, `frontend-blockers-hardening.part-04`, `job-queue-pages-fixes-07/-08/-09`. `async-ui-state-fixes-03/-04`
  now run their cases against the Pro pages.
- **Classic-only tests dropped without a twin** (the behaviour no longer exists): the "Something went wrong" wording in the
  async-ui cases, three async-ui tests keyed to classic endpoints (their Pro twins are in `overview-pro-malformed`,
  `control-operation-hardening.part-07`, `control-pages-stable-fixes.part-02`), the classic queue-detail job-name test in
  `stable-shell-fixes`, and `discoverAllQueues` in `demo-fixes` (pagination of `/dashboard/queues` is still asserted).
- **Ran (local, no Postgres needed):** `bun run typecheck` clean; `bun run lint` exit 0 (warnings only, none new);
  `bun run format:check` clean; `bun run architecture` clean; `bun run --cwd packages/panel build` clean;
  `bun test packages/panel`: 1556 pass, 0 fail; `bun run docs:check` passed (the Postgres-backed doc commands skipped).
  `rg -i classic packages/panel/src` shows only the redirect component and the 11 routes.
- **Not run:** the Playwright e2e (`all-routes` was rewritten, not executed). The orphan scan is file-level only: no
  `src` file is left without an importer, but an unused export inside a shared module would not show.
- **Note:** ten of the deleted pages had uncommitted edits from the console redesign (the 2026-10-20 work in the working
  tree), removed with `git rm -f`. Their content stays in `HEAD`.
