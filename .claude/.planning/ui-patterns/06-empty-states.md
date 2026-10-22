# V6 — Teaching empty states

**Status:** done · **Depends on:** none · **Touches:** packages/panel/src/components/ui, pages Cron, Webhooks, Flows, Dead letter queue

## Goal
An empty page says what the feature is, shows a small picture, and offers one button when there is something to do.

## Steps
1. `components/ui/illustrations.tsx`: four small inline SVGs in `currentColor` (a clock, a bell and arrow, linked nodes, an inbox with a tick). Decorative and `aria-hidden`.
2. `EmptyState` takes an optional `picture` slot; nothing else about it changes.
3. Wording: Cron "No schedules yet", Webhooks "No webhooks yet", Job flows, Dead letter queue "Nothing has failed". Plain words, no jargon.
4. One button where there is an action (Cron and Webhooks: open the create form). Flows and the Dead letter queue have no create action, so no button; they say how to get one.

## Acceptance
- Each of the four pages shows its teaching state when its list is empty, and the existing empty-state tests pass or are updated on purpose.
- The picture is `aria-hidden`; the title is the only heading.

## Verify
```bash
LC_ALL=en_US.UTF-8 bun test packages/panel
```

## Risks / notes
Tests pin some empty copy (`No dead letter entries`, `No deliveries`): change them deliberately.

## Result

**Changed** (`packages/panel`):
- `components/ui/illustrations.tsx` (new): `ClockDrawing`, `WebhookDrawing`, `FlowDrawing`, `InboxDrawing`, line drawings in `currentColor`
  (the arrows and secondary strokes at 55% opacity), 128 by 80, no text inside.
- `components/ui/feedback.tsx`: `EmptyState` takes `picture`. It is drawn in a `span aria-hidden="true"` and replaces the `icon` badge when both are given; nothing else changed.
- Copy: Cron (`CronManager`, the `/cron` route) "No schedules yet"; Webhooks "No webhooks yet"; Job flows keeps "No flows yet" (a test pins it) with a clearer hint;
  Dead letter queue (`DlqPro`, the `/dlq` route) "Nothing has failed" with "A job lands here when it has used all its tries and still failed. This queue has none, which is good."
  The filtered "No matches on this page" state keeps its icon.
- Tests: new `test/empty-states.test.tsx` (picture slot, Cron, Webhooks, DLQ), `flow-page.test.tsx` asserts the hint and the hidden picture.
  `e2e/walkthrough.e2e.ts` now looks for "Nothing has failed" where it looked for "No dead letter entries" (changed on purpose).

**Deviations**
- **No button on the Cron and Webhooks empty states.** After V3 the create form is already open above an empty list (`CreateCard empty`), so a "New ..." button would open nothing. The hint points at the form.
- **Only `/cron` and `/dlq` changed.** `pages/Cron.tsx`, `pages/Dlq.tsx` and `pages/control/DlqControl.tsx` (the old `/dlq-control` alias) keep their copy; tests pin "No scheduled jobs" on `Cron`.

**Ran:** `LC_ALL=en_US.UTF-8 bun test packages/panel/test/empty-states.test.tsx packages/panel/test/flow-page.test.tsx packages/panel/test/ui-feedback.test.tsx` 34 pass, 0 fail
(4 of them new); `bun run typecheck` clean; oxfmt clean. **Not run yet:** the full panel suite and the e2e (V8).

