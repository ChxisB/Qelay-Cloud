# 14 — Panel: queue policy and window

**Status:** done · **Depends on:** 12, 13 · **Touches:** packages/panel
**Design:** none (reuses existing pages and parts)

## Goal
The queue page shows and edits the retry policy and the run window.

## Steps
1. Two cards on the queue page: 'Retry policy' and 'Run window'. Each shows the current value, has one main action, and is disabled for a viewer.
2. Demo data and stub carry them. No new dependency.

## Acceptance
- Saving each card calls its route and shows the saved value; a bad value shows the API's message.
- Panel guards, build and axe pass.

## Verify
```bash
bun run --cwd packages/panel build && bun test packages/panel
```

## Result
Done. The queue page (`packages/panel/src/pages/control/queue/QueueSettings.tsx`) has two new cards under the stall and DLQ cards.

- **Retry policy** (`PolicyForm`): attempts, backoff kind (not set, the same each time, doubling each time), delay, longest delay (doubling only) and time limit, all in seconds. Blank fields are left out; every field blank sends `{}`, which removes the policy. A viewer sees a read-only facts card.
- **Run window** (`RunWindowForm`): cron, hours open, zone (blank is UTC), a "Remove window" button behind `confirmInPage`, and a closed/open status with the next open or close time (word plus glyph). A viewer sees a read-only facts card.
- A bad value shows the API's own message (`BqError` from the `{error:{code,message}}` body); the client-side checks only cover what the form can know (whole numbers, ranges).
- `queueApi` gained `getQueuePolicy`, `setQueuePolicy`, `getRunWindow`, `setRunWindow`, `clearRunWindow`; the demo API serves both (`emails` has a policy and a closed window). The panel's store-row schema gained `windowClosed` (a task 13 field) and its fixtures carry it.
- Deviations from the plan: the cards load their own data with `usePolledData` (30 s) and share `useSettingSave`, instead of passing it down from the page; "Remove window" is an addition the plan did not name. No new dependency, token or route.

Ran (local PG 18 not needed, panel only): `bun run typecheck` 0 errors, `bun run lint` 0 errors (existing warnings plus one `set-state-in-effect` warning in `useSettingSave.ts`, the same pattern the other forms use), `bun run format:check`, `bun run architecture`, `bun run --cwd packages/panel build`, `bun test packages/panel` 2204 pass / 0 fail (twice). `web-design-guidelines` applied. Axe on the stub panel: 0 violations in dark, light and phone width (390) with both cards open.

Not run: `bun run test:e2e`; the keyboard and focus pass (`accessibility-inspect`), since no new dialog was added and the cards reuse `ReadFirstCard` and `confirmInPage`; the visual check was by eye (no visual diff harness).
