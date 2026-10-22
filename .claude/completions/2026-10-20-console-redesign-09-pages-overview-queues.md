# Console redesign 09: Overview, Fleet, Queues, Queue detail (2026-10-20)

Plan: `.claude/.planning/console-redesign/09-pages-overview-queues.md`. Panel only; no route, API, auth or capability change.

## Changed
- `pages/control/overview/QueueHealthTable.tsx` and `OverviewHeader.tsx`: table recipe, status words, new heading.
- `pages/Fleet.tsx`, `features/fleet/FleetNodeCard.tsx`: `StatCard`, `Banner`, `StatusGlyph`.
- `pages/control/queues/QueuesTable.tsx`: table recipe.
- `pages/control/QueueDetailPro.tsx`, `pages/control/queueDetail/QueueDetailSections.tsx`: shared buttons, `StatusPill`, recent-jobs table on the recipe.
- Tests: new `test/page-tables-09.test.tsx`. No existing test changed.

## Checked
Panel suite 1469 pass / 0 fail from the repo root; typecheck, format:check, file-size and architecture clean; lint has no errors; panel build ok; screenshots of the four pages in both themes at 1440 and 390 (no horizontal scroll, no page errors).

## Owed or not run
Playwright e2e and axe not run (Postgres on 55442 was down); they run in the final verification.
The Fleet error banner is `role="alert"` now (was `status`). Board elements with no data in the panel are not built (R14).
