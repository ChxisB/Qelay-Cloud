# V7 — Shared list skeleton (optional)

**Status:** done (no change) · **Depends on:** none · **Touches:** packages/panel/src/components/ui, list pages

## Goal
One skeleton that fills the space of a table while it loads, in place of the text spinner on the main lists.

## Steps
1. `TableSkeleton` in `feedback.tsx` or its own file; reduced-motion safe.
2. Use it where a list shows `LoadingState` today (Cron, Webhooks, Flows, Dead letter queue) only if the change is one line per page.

## Acceptance
- Respects `prefers-reduced-motion`; announced once as "Loading" (`role="status"`).
- Skipped, with the reason in Result, if V1 to V6 ran long.

## Verify
```bash
LC_ALL=en_US.UTF-8 bun test packages/panel
```

## Risks / notes
Optional: dropping it does not block V8.

## Result

**No code written: the skeleton already exists.** `LoadingState` in `components/ui/feedback.tsx` (from the console redesign) is
already a four-row table-shaped skeleton: it pulses with `motion-safe:animate-pulse`, is announced once as `role="status"` with the page's
own label, and `test/ui-feedback.test.tsx` pins both. Cron (`CronManager`), Webhooks, Flows (`FlowPage`) and the Dead letter queue (`DlqPro`)
all use it, so there is no text spinner left to replace. A second component would be a duplicate; the plan's premise (a text spinner on the main lists) was out of date.
**Ran:** `grep` of the four pages for `LoadingState` and `Spinner`; no test run needed because nothing changed.

