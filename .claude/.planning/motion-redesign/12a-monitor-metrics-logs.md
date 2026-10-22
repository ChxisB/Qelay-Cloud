# 12a — Monitor: Metrics and Logs

**Status:** done · **Depends on:** 02, 05 · **Touches:** packages/panel/src/pages/control (MetricsPro, metrics/*, LogsPro, logs/*), test, e2e
**Design:** https://claude.ai/artifact/TMMbZ97jDRzvSpWiFVKRuG, board "Monitor" (Metrics and Logs frames; M1, M2, M7)

## Goal
Make the charts draw in once and move one step on a real poll, and let new log lines slide in, without changing what either page shows.

## Steps
1. Read the board, `DESIGN-MAP.md` ("Monitor", M1, M2, M7, M8) and `MetricsPro.tsx`, `metrics/*`, `LogsPro.tsx`, `logs/*` with their tests.
2. Metrics: charts use the task 05 draw-in (600ms, first load) and step slide (300ms, `transform` only, only when a poll adds a
   point). The success meter fills once with the task 05 `Meter`. Cells flash with `useChangeFlash` only on a real change.
3. M2: Total failed, Stale, Quarantined and the slow-p99 row carry a glyph and a word as well as colour (`StatusBadge`).
4. Logs: a new line slides in (`motion-arrive`, one line at a time, no stagger past 8 in one poll). Pause and "Resume — N new"
   behave as today and keep their words. A paused view animates nothing.
5. Edit the tests that pin old markup in the same change.

## Acceptance
- Every figure, filter and control on both pages is still there; no new request, no new poll.
- A poll that changes nothing animates nothing (a test with two identical polls shows no flash key change).
- Total failed, Stale, Quarantined and slow p99 each show a word and a glyph.
- Under reduced motion lines and points appear at once.

## Verify
```bash
bun test packages/panel/test/charts packages/panel/test/log-viewer packages/panel/test/hooks-throughput packages/panel/test/dashboard-payloads packages/panel/test/motion-guard.test.ts && bun run typecheck && bun run lint && bun run format:check
```

## Risks / notes
- A log tail of thousands of lines: only the newest lines of a poll animate; the list is not re-keyed, so older rows do not replay.
- The step slide must not shift the axis labels; check by eye on `dev:stub`.

## Result

**Built 2026-10-22.**

Already done by earlier tasks, so not touched here: the throughput charts draw in and step (task 05, `AreaChart`), the success `Meter` fills once (task 05), and the four stat cards wash their value on a real change (task 02, `StatCard`). `ThroughputCharts.tsx` is unchanged.

Changed (under `packages/panel`):
- `src/lib/useFreshAfter.ts` (new, 13 lines): given the head `seq` of a newest-first list, returns the head from before its latest change. Lines numbered above it came in with that change. A re-render, a filter or a paused view leaves it where it was; a list already there on open has nothing above it; a reconnect (the `seq` restarts low) animates nothing until the head passes the old one.
- `src/pages/control/LogsPro.tsx`: `useFreshAfter(source[0]?.seq)` on the unfiltered list, passed on as `freshAfter`.
- `src/pages/control/logs/LogsEventList.tsx`: optional `freshAfter` prop (so every older caller and test is unchanged). The newest 8 lines above it get `motion-arrive` and `stagger(place)`. The line is now an `EventLine` that reads its place once, so a later update never cuts a slide short or replays it. The key is still `seq`.
- `src/pages/control/MetricsPro.tsx`: Total failed shows the failed glyph beside "recorded jobs" when the count is above 0.
- `src/pages/control/metrics/MetricsStatusPanels.tsx`: the error and success rates and the Server overview rows wash on a real change of the shown text. Uptime is `steady` and never washes (it changes on every poll).
- `src/pages/control/metrics/MetricsTables.tsx`: the per-queue counts are `Figure`s (the failed count keeps its bold and red); a slow p99 (over 100 ms) reads `slow 180ms` with the delayed glyph, as well as the amber row and bold.

Tests (none loosened): new `test/monitor-motion.test.tsx` (11): `useFreshAfter` (first list, a moving head, an empty start); log lines (none without `freshAfter`, new ones slide in newest first and in order, only 8 of a burst, an old line keeps its element and place when the next update lands, a search over old lines animates nothing); metrics (two identical polls wash nothing, a moved count and the two rates wash once, uptime never washes, per-queue counts wash on a real change only, a slow p99 says "slow" with a glyph and a fast one does not).

Ran: `monitor-motion`, `page-tables-11`, `pro-pages-failure`, `state-colours`, `log-viewer`, `charts`, `hooks-throughput`, `dashboard-payloads`, `motion-guard` (all pass); `bun run typecheck` (root, tooling and the panel's src, node and e2e projects); `bun run lint` (exit 0; two warnings in the touched files were there before: the index key in `markHits` and the `setFrozen` effect in `LogsPro`); `bun run format:check`. Full panel suite from the repo root: 2019 pass, 0 fail, 274 files.

Deviations from the plan:
- Stale and Quarantined (M2) are on the Workers page, so they move to 12b.
- The plan said "one line at a time, no stagger past 8". It is a stagger of up to 8 within one update, as for rows elsewhere; with a steady stream that is one line per update.
- A line from the latest update that a filter or search was hiding slides in when the filter lifts (it mounts then). Up to 8 lines, once. Not fixed: it would need the list to remember what it has shown.
- No new request or poll was added. Latency avg, p50 and p95 do not wash: they move on nearly every poll and a wash on every cell is noise.

Needs the owner's word: nothing new in wording beyond the "slow" word before the p99 value.

Not run: the full repo gate (`architecture`, other packages), Postgres-backed tests, e2e, `dev:stub` by eye at 1280 px and 390 px, the accessibility scan. Unseen in a browser: the log line slide inside the scrolling viewer (the scroll container may clip it), and whether the chart step slide shifts the axis labels.
