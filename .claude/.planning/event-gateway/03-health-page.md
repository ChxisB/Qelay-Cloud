# 03 — One Health page

**Status:** done · **Depends on:** 01 · **Touches:** packages/panel

## Goal
Deployment, Diagnostics, Job delivery and Usage are tabs of one "Health" page, `/health`.

## Steps
1. New `/health` route with tabs (`?tab=deployment|diagnostics|delivery|usage`); each tab renders the existing page body.
2. Redirects: `/deployment`, `/diagnostics`, `/transport`, `/usage` to their tab. Capability gating (`capabilities/model.ts`)
   moves to per-tab: a closed tab is left out, the page is closed only when every tab is.
3. Keep each tab's own "unavailable" note (rubric line 7).

## Acceptance
- Four old paths redirect to the right tab (test); a closed feature hides its tab, not the page (test).
- Each tab shows what its page showed (existing page tests pass with the new mount point).

## Verify
```bash
bun run typecheck && bun test packages/panel
```

## Risks / notes
- Deployment and Transport poll the Control API on their own timers; mount only the active tab so a hidden tab does not poll.

## Result

### Plan correction
The plan said a new `/health` route with `?tab=` and four redirects. Done the way task 06 did Flows instead: the four reports
keep their own paths, and a tab bar (`SectionTabs`, `HealthTabs`) on each page links the other three. The sidebar has one
**Health** item (`to` the first path, `also` the rest, from the single `HEALTH_TABS` list in `navConfig.ts`), current on all
four. Why: nothing is mounted twice (an inactive report does not poll, which was the task's own risk), no bookmark moves, no
redirect table to keep, and the pages' existing tests keep their mount points. Cost: the URL is `/deployment`, not
`/health`. `/health?tab=` can be added later as a redirect without touching a page. Task 05's "every old path in a redirect
table" therefore does not apply to these four.
The plan's per-tab capability gating is moot: none of the four paths is gated in `capabilities/model.ts`. `SectionTabs` still
leaves out a path the deployment closes (the Flows tests cover that branch), and shows nothing for a lone tab.

### Parity
Nothing was removed from any report. The two cross-link buttons ("Job delivery" on Deployment, "Deployment" on Job delivery)
are replaced by the tab bar. `StatusStrip` still links to `/deployment`.

### What changed
- New `components/SectionTabs.tsx` (generic), `components/HealthTabs.tsx`; `FlowKindTabs` is now a thin use of `SectionTabs`.
- `navConfig.ts`: Health replaces Job delivery, Deployment, Diagnostics and Usage (nav is 19 items); `NavIcon.tsx` loses the
  three icons nothing uses.
- `Deployment`, `Transport`, `Diagnostics`, `UsagePro`: `<HealthTabs>` under each header, including the "unavailable" header.
- Tests: new `health-tabs.test.tsx` (tab bar marks the open page; one Health link in the sidebar, current on all four);
  `shell`, `nav-shell`, `nav-capabilities`, `ops-nav` pins updated; seven files that mounted a page without a router now wrap it
  in `MemoryRouter` (the tab bar uses `Link`).
- e2e: `monitoring` and `operations` reach Usage and Diagnostics through Health's tab bar.

### What ran
`typecheck` (with the e2e project), `lint` (exit 0), `format:check`, `architecture`, `bun test packages/panel` from the repo
root (1557 pass, 0 fail). **Not run:** Playwright e2e; the clip sweeps at 390 and 1440.

