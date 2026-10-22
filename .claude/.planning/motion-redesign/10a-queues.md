# 10a — Queues and the queue page

**Status:** done · **Depends on:** 03, 04b, 05 · **Touches:** packages/panel/src/pages/control (QueuesOverview, QueueDetailPro, queues/*, queue/*, queueDetail/*), test, e2e
**Design:** https://claude.ai/artifact/TMMbZ97jDRzvSpWiFVKRuG, board "Work" (queues part)

## Goal
Draw queues and one queue's depth, workers and throughput with the shared parts, and move their two confirms into the page.

## Steps
1. Read the board, `DESIGN-MAP.md` (deviations for "Work") and the files above with their tests.
2. `QueuesOverview`: rows with the stagger on first load, state as word and glyph, depth as a `Meter`. Replace the
   pause/resume `window.confirm` (line 136) with `confirmInPage`, same text and API.
3. `QueueDetailPro`: header figures flash on a polled change; the depth chart draws in once; tabs use the shared highlight.
   Replace its `confirmMsg` `window.confirm` (line 107) with `confirmInPage`.
4. Do not draw retry, remove, cancel, discard, purge, clean, drain or obliterate controls. Those stay gated by
   `shared/flowOperationPolicy.ts`.
5. Edit the tests and e2e that stub the dialog or pin old markup in the same change.

## Acceptance
- Both confirms ask in the page, call the same API on true and nothing on false.
- No gated control appears on either page (the existing operations-hidden and mutation-guard tests pass).
- Unchanged polls animate nothing; first load staggers at most 8 rows.

## Verify
```bash
bun test packages/panel/test/queue packages/panel/test/job-queue-pages-fixes packages/panel/test/queue-settings-operations-hidden.test.tsx packages/panel/test/mutation-action-guards packages/panel/test/motion-guard.test.ts && bun run typecheck && bun run lint && bun run format:check
```

## Risks / notes
- Name the test folders that exist when you start in the Result; the globs above are a starting point.
- A queue with 1000 rows must not stagger past 8.

## Result
Built and closed 2026-10-22.

**Changed (packages/panel):**
- `ui/Figure.tsx` (new): a count that washes once when a poll really changes it.
- `queues/QueuesTable.tsx`: first-load stagger (cap 8, in CSS), `Figure` cells, row action named after its queue (W6: "Pause queue, orders").
- `QueuesOverview.tsx`: Pause all / Resume all ask with `confirmInPage` ("Pause queues" / "Resume queues").
- `QueueDetailPro.tsx` and `queue/*Card.tsx`: `run` asks with `confirmInPage` before Run delayed jobs, speed limit and concurrency cap; each confirm button carries the action's own verb and the two removals are `danger`. Overview/Settings is `LinkTabs`; the state tiles use `STATE_LABEL` (W3).
- `queueDetail/QueueLifecycle.tsx` (new, W1): where this queue's jobs are, drawn with the shared `Node`/`Edge` of the overview flow; a line pulses only when its count changes. `queueDetail/QueueDetailSections.tsx`: recent jobs arrive once, the priority fill uses `motion-fill`.

**Tests:** `queues-motion.test.tsx` (new, 9), `confirmSupport.ts` (new helper: answers the in-page question), and the confirm assertions of `queue-detail-pro-safety`, `queue-settings-04` and `server-action-pages*` now read the question from the page instead of `window.confirm`. No assertion was loosened.
`installTestHooks({ yesToQuestions })` is opt-in: it first answered yes for every page test, which overrode the gateway tests that drive the real dialog (60 failures in the full run until fixed).

**Deviations (need the owner's word):**
1. Overview/Settings tabs push a history entry; the old control replaced it (`setParams(..., {replace: true})`).
2. Confirm buttons say the action's verb, not "OK"; seven new button names.
3. W1 wording ("Where this queue's jobs are", the sub line) is new.
4. No depth `Meter` in the queues table (the board draws one; the table has counts only).

**Ran:** the Verify command (98 pass), `queues-motion` (9 pass), typecheck, lint, format:check and the panel build, all on 2026-10-22. Full panel suite from the repo root: 1980 pass, 0 fail, 269 files.
**Not run:** by eye in a browser (the lifecycle diagram, tab underline, `motion-flash` on an inline figure are unseen), e2e, the full repo gate and Docker-backed runs (task 15).
