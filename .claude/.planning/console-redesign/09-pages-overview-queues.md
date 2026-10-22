# 09 — Pages: Overview, Fleet, Queues, Queue detail

**Status:** done · **Depends on:** 06, 08 · **Touches:** packages/panel/src/pages/control (OverviewPro, Fleet, Queues, QueueDetail and their parts), packages/panel/test, packages/panel/e2e

## Goal
Overview, Fleet, Queues and the queue detail page use the new primitives and match their boards, with the same data and actions.

## Steps
1. Read each board in full (Main, Fleet, Queues, Queue detail) and the page's source and tests.
2. Overview: key-figure row, throughput chart, queue table with the status bars, recent-activity card. Only the data the
   page already loads (R14: no seeded samples). A figure with no source in the panel is dropped and listed in the Result.
3. Fleet, Queues, queue detail: table recipe, status glyphs, toolbar controls, tabs for the detail page.
4. `*-classic` siblings follow by tokens only (R12). Nothing is rebuilt.
5. Update tests and e2e that assert old markup.

## Acceptance
- Each page renders the same data and keeps every action it had (existing tests pass, with string updates only).
- Every status shown has a glyph and a word.
- Empty, loading and error states are the shared ones from task 05.
- `axe` has no new serious or critical finding on these routes (e2e when the stack is up; otherwise stated as not run).

## Verify
```bash
bun test packages/panel && bun run typecheck && bun run lint && bun run format:check
```

## Risks / notes
- Overview is the heaviest page. Keep each file under 300 lines by splitting parts, as the page already does.

## Result

Overview, Fleet, Queues and the queue detail page are on the new primitives. Same data, same actions, same routes.

**Changed**
- Overview: `QueueHealthTable` on the table recipe (status bar plus a `StatusPill` word under the queue name: Failing, Paused, Active, Healthy, Unknown), a larger h1 and a lede in `OverviewHeader`.
- Fleet: `StatCard` tiles, the shared `Banner` for the error, `StatusGlyph` in place of the old dot on node cards, a restyled "active" badge.
- Queues: `QueuesTable` rewritten on the recipe (Active / Paused pill, failed row bar).
- Queue detail: back link, header buttons and state pill use `iconButtonClass`, `LinkButton` and `StatusPill`; the recent-jobs table is on the recipe with `StatusBadge`.
- Tests: new `test/page-tables-09.test.tsx` (row word and bar for failing, paused, active, healthy and unreadable queues; an unreadable queue is never shown as healthy; column headers have `scope`; a cell carries one side-padding rule). No existing test changed.

**Ran**
- `bun test packages/panel` from the repo root: 1469 pass / 0 fail.
- `bun run typecheck`, `bun run format:check`, `bun scripts/check-file-size.ts`, `bun run architecture`: clean. `bun run lint`: no errors; the warnings left in these files (`set-state-in-effect` in `Fleet`, `QueueDetail`, `QueueDetailPro`, `refs` in `OverviewPro`) were there at HEAD.
- Panel build: ok.
- Screenshots of the four pages in `?demo`, both themes, 1440 and 390 wide, from `vite preview`: no horizontal scroll, no page errors.

**Not run**
- Playwright e2e and `axe`: the local Postgres on 55442 was down, so the stack was not up. Left for Phase 4 once pages 10 to 14 are done.
- No screenshot diff against the boards; looked at by eye.

**Not built (R14, no data source)**: the boards' sample sparklines, per-queue throughput columns and activity rows that have no data in the panel.

**Changed behaviour to note**: the Fleet error banner is `role="alert"` now (was `status`), because the shared `Banner` maps a problem tone to `alert`. No test referenced the old role.

**Kept**: page h1 texts ("Overview", "Fleet", "Queues"), since tests and e2e find them by name. The boards' longer titles were not adopted.

**Seen, not fixed**: on the queue detail page the "waiting-children" tile label wraps to two lines at 1440 and pushes its figure lower than the other tiles. The label is existing copy.
