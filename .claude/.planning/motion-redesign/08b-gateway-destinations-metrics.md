# 08b — Gateway destinations and metrics

**Status:** done · **Depends on:** 06 · **Touches:** packages/panel/src/pages/control/gateway (Destinations, DestinationForm, useDestinationRemove, Metrics, MetricsParts), test, e2e
**Design:** https://claude.ai/artifact/TMMbZ97jDRzvSpWiFVKRuG, board "Gateway more"

## Goal
Show each destination with the connections that feed it, and draw the gateway metrics with the shared chart and figure parts.

## Steps
1. Read the board, `DESIGN-MAP.md` (deviations for this board) and the files above with their tests.
2. `Destinations`: each destination is a `ConnectionNode` with the connections that use it drawn as short `ConnectionLine`s, from data
   the panel already loads. Cards arrive with the stagger. `DestinationForm` opens with `usePresence`.
3. `useDestinationRemove.ts`: replace the `window.confirm` with `confirmInPage` (same text, same API). It must still refuse a
   destination that connections use, if it does today.
4. `Metrics`/`MetricsParts`: figures flash on a polled change; charts use the task 05 draw-in; the range control keeps its state.
5. Edit the tests and e2e that stub the dialog or pin old markup in the same change.

## Acceptance
- The destination list, form and remove behave as today, apart from the in-page confirm.
- A destination with no connections draws no line and says so in words.
- Charts have a text summary; a range change redraws once.
- Reduced motion shows the end state.

## Verify
```bash
bun test packages/panel/test/gateway packages/panel/test/motion-guard.test.ts && bun run typecheck && bun run lint && bun run format:check
```

## Risks / notes
- If the panel does not load which connections use a destination, draw no lines and record the board difference as a deviation. Do not add a request.

## Result
Done 2026-10-22.

**Changed** (all under `packages/panel`):
- `DestinationCard.tsx` (new), `DestinationLines.tsx` (new): each destination is a card with up to four `ConnectionLine`s into it and
  "+n more" past four, `aria-hidden`, so the sentence "N connections are made from it." carries the meaning. No connections: no line
  and "No connection is made from it yet." Lines go dashed while the address in the open form differs from the saved one and flash once
  when a poll shows a changed saved address.
- `Destinations.tsx`, `DestinationForm.tsx`: cards arrive in the stagger (first load, and one that a poll adds); both forms open and
  leave with `usePresence` (180 ms exit, `inert` while leaving); the empty message waits for the new-destination form to finish leaving.
- `useDestinationRemove.ts`: `window.confirm` is now `confirmInPage` with the same question. The in-use refusal and the refetch are as before.
- `EndStates.tsx` (new), `MetricsParts.tsx`: a "Where events went" card (events matched, then Successful, Failed, Pending) with a count and
  a share in words and a `Meter` as the second reading; figures wash once on a polled change.
- Tests: `gateway-destinations-motion.test.tsx` (8), `gateway-metrics-strip.test.tsx` (3); the Remove tests in
  `gateway-destinations.test.tsx` now answer the page dialog and wait out the 180 ms exit.

**Ran:**
- `bun test packages/panel/test/gateway packages/panel/test/motion-guard`: 277 pass, 0 fail.
- `bun run typecheck`, `bun run lint` (exit 0; the pre-existing warnings only, none in new files), `bun run format:check`: clean.
- `bun run --cwd packages/panel build`: built.
- `bun test packages/panel`: 1953 pass, 0 fail, 266 files, 111 s. A first run, with the lid closed on battery, gave 42 fail and single tests of 2 to 17 minutes (Maintenance Sleep); the 37
  failing files each pass in their own process, and the rerun with the lid open is clean. No source was changed between the runs.

**Deviations** (also in DESIGN-MAP.md, G7):
- "Preview a poll" is not built, and the strip has no drawn wires out of it: the existing `Meter` bars are used.
- Destination lines carry no names: the panel only has the count of connections that use an address.
- `pending` is not one of the six number cards; it is read from the same stats call, so no request was added.
- A range with no events keeps today's empty message, so the strip never shows at zero.
- Focus is not returned anywhere after a successful Remove (the card is gone).
- `confirmInPage` is async where `window.confirm` was synchronous.
- New wording "Where events went", "Events matched", "Pending" needs the owner's word.

**Not run:** by eye in a browser (the line, strip and card classes are unseen); e2e; the full repo gate and Postgres-backed tests (task 15).
