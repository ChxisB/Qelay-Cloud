# 06 — One Flows page

**Status:** done · **Depends on:** none · **Touches:** packages/panel

## Goal
Job flows and workflow runs are one nav item, "Flows", with a kind switch. The engines and the Control API are untouched.

## Steps
(Changed while building: the kind switch is two tabs over the two existing routes, not a `?kind=` query. `flowUrlState`
and `workflowUrlState` strip unknown params, and `/workflows?execution=` deep links already exist everywhere.)
1. One nav item "Flows" at `/flows` that also matches `/workflows` (`also` on the nav item), opening on whichever kind
   the server offers.
2. A "Kind of flow" tab bar (`FlowKindTabs`, built on the new `LinkTabs`) above both pages: "Job flows" → `/flows`,
   "Workflow runs" → `/workflows`.
3. Both pages carry the title "Flows" and one sentence each. Each kind keeps its own filters and URL state.
4. Capability gating: a tab shows only when its feature is on; with one kind served there is no tab bar, and the nav
   item goes to that kind. Closed only when both are off.

## Acceptance
- Old `/workflows…` links keep working unchanged, because the route stays (nothing to redirect). Tests: `workflow-page`, `flow-kind-tabs`.
- With only one feature on, the tab bar is not shown and the nav link goes to that kind (`flow-kind-tabs.test.tsx`).
- `shared/flowOperationPolicy.ts` unchanged and its tests pass (the Purge buttons stay disabled).

## Verify
```bash
bun run typecheck && bun test packages/panel
```

## Risks / notes
- A merged list across both kinds needs two cursors; not built. Revisit only if the owner wants one table.

## Result
- **Changed:** `navConfig.ts` (`also`, `navPaths`, `visibleNav`, `locateNav`), `NavItem.tsx` (`Link` + `matchPath`, because
  `NavLink` cannot mark an item current on its `also` paths), new `ui/LinkTabs.tsx` and `FlowKindTabs.tsx`, titles in
  `FlowPage.tsx` and `WorkflowPage.tsx`, new `test/flow-kind-tabs.test.tsx` (5 tests), and the pins in `shell`,
  `nav-shell` (28 → 27 on purpose), `flow-page`, plus `e2e/flows`, `workflows` and `dashboard`.
- **Ran:** `bun run typecheck` (clean), `bun run lint` (warnings only, none in the changed files), `bun run format:check`
  (clean after `oxfmt`), `bun test packages/panel`: 1578 pass, 0 fail.
- **Not run:** the Playwright e2e (`flows`, `workflows`, `dashboard` were edited but not executed), and the 390/1440 clip sweeps.
- `shared/flowOperationPolicy.ts` untouched.
