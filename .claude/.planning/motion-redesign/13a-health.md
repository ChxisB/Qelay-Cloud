# 13a — Health: Deployment, Diagnostics, Transport, Usage

**Status:** done · **Depends on:** 03, 05 · **Touches:** packages/panel/src/pages/control (Deployment, deployment/*, Diagnostics, diagnostics/*, Transport, transport/*, UsagePro), components/HealthTabs.tsx, test, e2e
**Design:** https://claude.ai/artifact/TMMbZ97jDRzvSpWiFVKRuG, board "Health" (H1 to H5)

## Goal
Draw the health chain (database, doorbell, workers) with the shared parts and give every figure, meter and warning a quiet, honest motion.

## Steps
1. Read the board, `DESIGN-MAP.md` ("Health", H1 to H8) and the four pages with their tests.
2. Deployment and Transport: the chain as `ConnectionNode` and `ConnectionLine`, from data the pages already load. A probe state is a
   glyph and a word (H1). Tabs use the shared highlight (04a).
3. Usage: H2 adds a delivery line above the Job delivery table. It draws totals of that table only, says "unknown" where it does
   not know, and "of the queues shown" when the table is cut off. This is new wording, approved 2026-10-22.
4. Diagnostics: Ping, Compact (GC) and heap results animate in (H5). What the actions do does not change.
5. Meters fill once, then move on a change; warnings rise in order, the critical one stays `role="alert"` (H3). Figures flash
   only on a real poll change; "Ns ago" updates without a flash (H4).
6. Do not add a redrive or retry control for failed notifications (H6): they stay read-only and operator-only.
7. Edit the tests that pin old markup in the same change.

## Acceptance
- Every probe, figure, warning and table the four pages show today still shows. No new request.
- H2 never states a number the table does not hold; with a cut-off table it says so in words.
- Critical warnings keep `role="alert"`; severity, verdict and probe state each have a glyph and a word.
- No gated control is drawn (the existing operations-hidden and mutation-guard tests pass).

## Verify
```bash
bun test packages/panel/test/ops- packages/panel/test/health-tabs packages/panel/test/diagnostic-endpoints packages/panel/test/state-colours.test.tsx packages/panel/test/queue-settings-operations-hidden.test.tsx packages/panel/test/mutation-action-guards packages/panel/test/motion-guard.test.ts && bun run typecheck && bun run lint && bun run format:check
```

## Risks / notes
- If a chain edge needs data the page does not load, draw the node without the edge and record a deviation.
- "Ns ago" must not re-render the whole card each second; keep the tick in its own component.

## Result
Built 2026-10-22. No new request, route, dependency or colour.

- **Warnings** (`WarningList`): the first load rises in order, critical first, and a critical warning keeps `role="alert"`. A warning a later poll adds rises alone, an equal poll keeps every element, and a cleared one leaves (`motion-leave`, `inert`) before "No warnings." appears.
- **Figures** (new `ui/Wash.tsx`, used by Deployment facts, the Job delivery table, Diagnostics and Usage): a text figure washes once on a real poll change. An age, a timing or an uptime that moves on every poll is `steady` and updates without the wash (`StatCard` gained `steady` for the Uptime cards). In Deployment the date of "Last success" washes; "(Ns ago)" is plain text beside it.
- **Delivery line** (new `transport/DeliveryLine.tsx`, drawn above the notification-health table on Job delivery): Ready to run → In queue service → Picked up, with a line for "not told yet" and one for "given up on". Every total is a sum over the rows of the table and nothing else; any unknown row makes the total "unknown" with "N of M queues did not answer"; a cut-off table says "the queues shown". A line pulses once when the count at its end really changes.
- **Table** (`QueueDoorbellTable`): rows of the first read rise in a stagger, a later poll's rows do not; readings wash on a change; ages are steady.
- **Diagnostics and Usage**: the Ping result fades in, the Compact (GC) message and the heap result rise in, Uptime does not wash, and the Usage storage banner re-arrives when disk-full flips.
- Tests: new `test/health-motion.test.tsx` (20 tests). No old test was edited.

**Ran:** the Verify command (180 pass, 0 fail, 16 files), `bun run typecheck`, `bun run lint` (exit 0, existing warnings only), `bun run format:check`, and the full panel suite from the repo root (2048 pass, 0 fail, 276 files; the baseline was 2028).
**Not run:** the full repo gate, e2e, Postgres-backed tests, `dev:stub` by eye, the accessibility scan (task 15). The Usage disk-full flip is not unit-tested (it needs a poll interval to pass).

**Deviations** (also in DESIGN-MAP, "Health"):
- The plan said "Usage" for H2; the board and DESIGN-MAP put the delivery line on Job delivery, which is where it is.
- Deployment draws no chain of nodes: its cards keep their layout and the chain is the delivery line (no data for a database → worker edge beyond what the cards show).
- No per-second "Ns ago" tick: it updates once per poll, in plain text outside the wash, so nothing re-renders each second.
- The board's "Picked up … From the database" hint is "From the queue service", because `inFlight` comes from the broker. The total shows "not reported" when no queue reports it (the table hides that column then). "≈" follows the table (any value when the broker is approximate).
- Edge pulses are keyed to the count at the destination (`queued`, `picked`), not to the edge text.
- Probe rows (`StatusDot`) do not ping. Unknown → number in the table does not wash.
- The narrow layout uses a fixed 3.5rem vertical edge; the wide grid column widths are estimates, unseen in a browser.
- No redrive or retry control (H6).
