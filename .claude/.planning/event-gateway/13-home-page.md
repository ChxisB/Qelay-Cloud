# 13 — Home: one screen for every metric and error

**Status:** done · **Depends on:** 10, 05 · **Touches:** packages/panel

## Goal
Overview becomes **Home**: the one page where every metric and every error in the console can be seen, each card linking to
the page that has the detail. No new nav item and no new metric source: the numbers come from the calls the pages already make.

## What is true today
`OverviewPro` (at `/`) already has an attention strip, KPI tiles, throughput, queue health and recent activity
(`overview/loadOverview.ts`). Metrics live on Queues, Workers, Metrics, Alerts, Health (Diagnostics, Job delivery, Usage),
Cron jobs and the DLQ. Home must show all of them, not duplicate their charts.

## Steps
1. List what each page shows (a table in this file's Result: card, source call, link). Reuse the call; do not add one except the
   Event gateway card, which takes task 10's stats call.
2. Home has two bands. **Needs attention** (top): one row per open problem, worst first, each a link: firing alerts, dead
   letters, workers gone quiet, a queue backed up or paused, an event-gateway route paused or failing, a health warning
   (`/ops/warnings`), a job-delivery lag or its dead-letter doorbells. **Numbers** (below): one card per area (Queues, Jobs,
   DLQ, Workers, Cron, Event gateway, Job delivery, Health) with its headline figure, a small trend, and a "View" link.
3. Rename the nav item and title Overview to **Home**; `/` stays. Breadcrumb, palette and tests follow (`shell.test.tsx`
   `DESIGN_NAV`, `nav-capabilities.test.tsx`).
4. Capability rules hold: a card for a page the deployment closes is not shown (flows, workflows, webhooks, server, ...).
5. A card whose call fails shows "unavailable" in its own place; one failure never blanks the page (as Overview does now).

## Acceptance
- Each area above has a card or an attention row, and each links to its page (test over a fixture of every call).
- A closed capability leaves its card out; a failing call leaves only its card in an error state (tests).
- The attention list is empty with a plain "Nothing needs attention" when all is well, and ordered worst first when not (test).
- No new store call, route or migration (the stats call from 10 is the only new read).

## Verify
```bash
bun run typecheck && bun test packages/panel
```

## Risks / notes
- The Event gateway card needs task 10. If this task is built before 10, ship every other card and add that one with 10.
- "All the metrics" is bounded by what the Control API serves; a page that computes its numbers client-side is linked, not copied.
- Fan-out: Home makes one call per card. Load them in parallel with a shared refresh interval, and reuse the capability gate so
  a closed deployment does not call routes it does not serve.

## Result

Overview became **Home** (`/` unchanged; nav label, page title and breadcrumb say Home). It is the existing `OverviewPro` page
with two bands added above the tiles it already had. No new route, store call or migration; the one new read is task 10's stats
call, and only when the Event gateway is open.

**Needs attention** (`home/AttentionList.tsx`, `home/model.ts`): one row per open problem, worst first, each a link. Order:
critical health warning, firing alerts, dead letters, a paused gateway route, workers gone quiet, paused queues, a backlog
(over the existing 100-job amber threshold), failed jobs (only when there are no dead letters), a failing gateway route,
poison or late doorbells, then the other health warnings. Empty and settled says "Nothing needs attention."; a source that
could not be read adds "Could not be read: ..." instead of a false all-clear.

**Numbers** (`home/HomeCards.tsx`), one linked card per area:

| Card | Source call | Link |
|---|---|---|
| Queues | `bq.queuesSummary()` (Overview's own call) | `/queues` |
| Jobs | `bq.overview()` (`/dashboard`, Overview's own call) | `/jobs` |
| Dead letter queue | `bq.overview()`; left out when `/dlq` is closed | `/dlq` |
| Workers | `api.deployment()` (`/deployment`) | `/workers` |
| Cron jobs | `bq.overview()`; left out when `/cron` is closed | `/cron` |
| Event gateway | `bq.webhooks()` and `bq.webhookStats()` (last 24h); no call and no card when `/events-gateway` is closed | `/events-gateway/metrics` |
| Job delivery | `api.deployment()` doorbells and `api.transport()` | `/transport` |
| Health | `api.deployment()` (database, transport, warnings) | `/deployment` |
| Alerts | none: `useAlertRuntimeStore.breaching` (alert rules live in this browser) | `/alerts` |

Metrics is the existing tiles and throughput chart on the same page; Usage stays one click away from Health and is not copied.
`/deployment` is polled once and shared by the status strip (now `StatusStripView`) and the cards. A failed call shows
"Unavailable" in that card only (Workers, Health, Event gateway, Job delivery); the page never blanks. Home's feeds pause with
the page's Pause button.

**Changed beside it:** `NeedsAttention.tsx` was deleted and replaced by `AttentionList`; `loadOverview` now also returns
`pausedQueues`; `shell.test.tsx` and `nav-shell.test.tsx` say Home; the e2e specs and `e2e/fixtures.ts` look for the heading
"Home". In `test/overview-render.test.tsx` the DLQ-link assertion was **scoped to the attention section**: the new DLQ card is
also an `a[href^="/dlq"]`, so the unscoped query matched it. The assertion still checks the same thing (a healthy server has
no DLQ link in the attention list).

**Tests:** `test/home-model.test.ts` (6: ordering over ten ids, healthy is empty, an unreadable source adds nothing, failed jobs
only without dead letters, one paused route is named and several are counted, doorbell lateness is read against `lateAfterMs`)
and `test/home.test.tsx` (5: every area has a card with the right href, healthy says "Nothing needs attention.", six problems
appear worst first with the right hrefs, closed capabilities leave out cards and make no `/webhooks*` call, and a failing
`/deployment` and `/webhooks` leave only their own cards "Unavailable").

**Ran** (no Docker, 2026-10-21): `bun run typecheck` 0; `bun run format:check` clean (after `oxfmt` on `useHomeFeeds.ts`);
`bun run architecture` clean (all files under 300 lines); `bun run lint` exits 0, warnings only (the `refs` warning on
`OverviewPro.tsx` is the existing `history.current` read that was already there); `bun test packages/panel` 1607 pass, 0 fail.

**Did not run:** Playwright e2e (the renamed "Home" headings only type-check) and the 390 and 1440 clip sweeps. No test of the
page against a real Control API; the fixtures are fetch stubs.

**On purpose / not done:**
- The plan's "small trend" per card was **not built**: Home reuses the existing throughput chart rather than adding a second
  history source per area. Cards show one figure and a hint.
- "Event gateway" shows the 24h failure ratio, not a trend line.
- Alerts are browser-local rules, so that card and the alerts attention row speak for this browser only.
- The backlog row reuses the old 100-job amber threshold; there is no per-queue setting.

