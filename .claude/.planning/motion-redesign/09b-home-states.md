# 09b — Home: glyphs, attention, activity, queue health

**Status:** done · **Depends on:** 09a · **Touches:** packages/panel/src/pages/control (OverviewHeader, StatusStrip, home/*, overview/RecentActivity, overview/QueueHealthTable, ThroughputCard), test, e2e
**Design:** https://claude.ai/artifact/TMMbZ97jDRzvSpWiFVKRuG, board "Home" (Home H2 to H5)

## Goal
Finish the Home board: states carry a glyph, "Needs attention" appears and clears quietly, new activity rises in, and the queue
health table draws once.

## Steps
1. Read the board, `DESIGN-MAP.md` ("Home H2" to "Home H5") and the files above with their tests.
2. H2: the connection word in the header, the state word in `StatusStripView` and the delivery hint in `HomeCards` get the state glyph.
3. H3: `AttentionList` becomes a polite live region; an issue rises in (240 ms) and fades out (180 ms) with `usePresence`; "Nothing
   needs attention." gets the ok glyph.
4. H4: `RecentActivity` rises a new event in; `QueueHealthTable` bars draw once, a changed count flashes, rows arrive with
   `useFirstLoad`/`useRowArrivals`; the throughput chart keeps its task 05 draw-in. Figure cards arrive in one stagger on first load only.
5. H5: the sample on the board is not data; nothing is copied.
6. Edit the tests and e2e that pin the old markup in the same change.

## Acceptance
- Every figure, link and state Home has today still shows. No new request, nothing that `flowOperationPolicy.ts` gates off is drawn.
- A poll that changes nothing animates nothing.
- The empty, loading, error and offline states use the task 05 parts.
- Light and dark pass the token guards.

## Verify
```bash
bun test packages/panel/test/overview packages/panel/test/home packages/panel/test/motion-guard.test.ts && bun run typecheck && bun run lint && bun run format:check
```

## Risks / notes
- The phone collapse of Needs attention is an expand control, not a route, if it is built (deviation).

## Result
Done 2026-10-22.

**Changed** (all under `packages/panel`):
- `OverviewHeader.tsx`, `StatusStrip.tsx`: the colour dot became `StatusGlyph` (tone to role: green completed, amber delayed, red failed, zinc waiting).
- `home/HomeCards.tsx`: a hint whose tone means something gets its glyph; each card rises in a stagger (`motion-arrive`, mounted once when Home first shows).
- `home/AttentionList.tsx`: `aria-live="polite"`; an issue rises in, a cleared one leaves with `motion-leave` and `inert` (via `useLeavers`); the ok glyph on "Nothing needs attention" (the dash when a source could not be read).
- `lib/useLeavers.ts`: ids may be strings and the list may be read-only (the Toaster is unchanged).
- `overview/RecentActivity.tsx`: only an event after the first read gets `motion-arrive`.
- `overview/QueueHealthTable.tsx`: rows arrive on first load (`useFirstLoad`), bar segments carry `motion-fill`, `Num` washes a changed count.
- Tests: `home-states.test.tsx` (11: header, strip and card glyphs, the live region, issue in and out, no restart on a same poll, the ok glyph, first-load rows, bars drawn once, one count washed, a later activity event rising in over a real SSE stream).

**Ran:**
- `bun test packages/panel/test/overview packages/panel/test/home packages/panel/test/motion-guard.test.ts` plus `page-tables-09`, `state-colours`, `ops-status-strip`: 96 pass, 0 fail.
- `bun run typecheck`, `bun run lint` (exit 0), `bun run format:check`: clean.
- `bun run --cwd packages/panel build`: built.
- `bun test packages/panel`: 1971 pass, 0 fail, 268 files, 111 s (lid open, battery 93%).

**Deviations:** the phone collapse of Needs attention is not built (the list holds only open problems); Recent activity rows keep their dot (the words already name the state); the board's 240 ms rise is the 300 ms `--dur-enter` token. No new wording.

**Not run:** by eye in a browser (the leave, the bar draw and the wash are unit-tested for their classes only); e2e (`deployment.e2e.ts` reads `data-tone`, which is unchanged); the full repo gate and Postgres-backed tests (task 15).
