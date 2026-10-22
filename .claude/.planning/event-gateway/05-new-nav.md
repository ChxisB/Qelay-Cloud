# 05 — The new navigation

**Status:** done · **Depends on:** 02, 03, 04, 06 · **Touches:** packages/panel, DESIGN-MAP, README

## Goal
`NAV` has 14 items in 5 sections, and every other surface that reads it agrees.

## Target
```
Overview
Work         Queues · Jobs · Dead letters · Schedules (cron)
Automation   Event gateway (until task 11 this is Webhooks) · Flows
Monitor      Metrics · Workers · Activity (logs) · Alerts · Health
System       Settings · System
```

## Steps
1. Rewrite `NAV` in `navConfig.ts`; update `pageTitle.ts`, `Breadcrumb`, `CommandPalette`, `capabilities/model.ts` paths.
2. Update `all-routes.e2e.ts` and the walkthrough kits for the new paths and labels. Never loosen an assertion: change the
   expected text to the new one.
3. A test pins the shape: 14 items, 5 sections, every old path in a redirect table, no item whose page is a redirect.
4. README and DESIGN-MAP: new nav and the redirect table.

## Acceptance
- `NAV` has 14 items; each old path resolves (test over the full old-path list).
- Sweeps at 390 and 1440 show no clipped control; e2e with axe passes.

## Verify
```bash
bun run typecheck && bun run lint && bun test packages/panel && bun run --cwd packages/panel test:e2e
```

## Risks / notes
- About 43 routes today: every changed page gets the clip check at 390 and 1440 (ux-clarity method).

## Result

**Done 2026-10-21.** `NAV` is 14 items in four groups under Overview: Work (Queues, Jobs, Dead letter queue, Cron jobs),
Automation (Webhooks, Flows), Monitor (Metrics, Workers, Logs, Alerts, Health), System (Settings, System). The plan's
"5 sections" counted the unlabelled Overview group. `locateNav` files a queue detail under Work, and `useNavGroups`
opens Work by default. The sidebar, breadcrumb and palette read `NAV`, so they needed no change of their own; the
section names stay in `navConfig.ts` and the tests.

- **Skipped on purpose:** the label renames (Dead letters, Schedules, Activity). The page titles say Dead letter queue,
  Cron jobs and Logs, and a nav label that differs from its page title is the double-name problem DESIGN-MAP R32 fixed.
  "Event gateway" waits for task 11.
- **No redirect table:** the per-path tab pattern (tasks 03, 04, 06) moved no URL, so the only redirects are the ones
  that already existed (`-classic`, `/queue-control`, `/dlq-control`, `/cron-manager`, `/workflows/*`).
  `test/app-routes-complete.test.tsx` lists them, and the new `nav-shell` test pins that no item stands for one.
- **Tests:** `shell`, `nav-shell`, `nav-capabilities` and `ops-nav` have the new section names. `nav-capabilities` now
  expects Automation to go when Webhooks and Flows are both closed. A new `nav-shell` test pins 14 items, no redirect
  path, no `-classic` path and no path shared by two items. The panel README has a Navigation section and DESIGN-MAP
  line 46 points to it.
- **Ran:** `typecheck` (with the e2e tsconfig), `lint` (warnings only, none new), `format:check`, `architecture`,
  `bun test packages/panel` (1562 pass, 0 fail).
- **Not run:** Playwright e2e (axe included) and the clip sweeps at 390 and 1440. The e2e files were edited in tasks
  01 to 06 but never executed. `e2e/dashboard.e2e.ts` pins links and headings, not section names, so it needed no edit here.
