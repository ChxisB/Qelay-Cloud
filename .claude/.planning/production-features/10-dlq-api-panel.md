# 10 — API and panel: DLQ retry and retention

**Status:** done · **Depends on:** 09 · **Touches:** packages/control-api, docs/openapi.yaml, docs/unsupported.md, docs/compat.md, packages/panel
**Design:** none (reuses existing pages and parts)

## Goal
The two 501 DLQ retry routes work, retention can be saved, and the DLQ page has Retry.

## Steps
1. Routes: POST /queues/{queue}/dlq/{jobId}/retry (expectedVersion optional), POST /queues/{queue}/dlq/retry ({ confirm: queue, limit })? operator role, audited, bounded by actionBudgetMs like purge. PUT /queues/{queue}/dlq-config accepts maxAge and maxEntries.
2. Remove dlq-retry and dlq-retention from the unsupported capability list; keep dlq-auto-retry unsupported.
3. SDK: `queue.retryDlq(jobId)` and `retryDlqMany` on the same store call.
4. Panel: Retry on a DLQ row and 'Retry up to 500' with a confirm; retention fields on the DLQ settings.
5. docs/unsupported.md, compat.md, migration.md: rows move from unsupported to supported.

## Acceptance
- A viewer role gets 403; an operator retries; the audit row records the route and the job id, never the payload.
- GET /capabilities no longer lists dlq-retry and dlq-retention under unsupported.
- openapi test and security:routes pass.
- The panel retries one and a set, and shows the remainder when the call stopped at its budget.

## Verify
```bash
QCLOUD_REQUIRE_DB=1 bun test packages/control-api packages/sdk && bun run --cwd packages/panel build && bun run security:routes
```

## Result
**Done.** Run on scratch Postgres 18, no Docker, no cloud, no real browser session beyond a local Playwright scan.

- Routes: `POST /queues/{queue}/dlq/{jobId}/retry` (optional `expectedVersion`; 409 with the typed reason) and
  `POST /queues/{queue}/dlq/retry` (`{ confirm: queue, limit, reason? }`, up to 500, replies `count`, `remaining`, `done`);
  `PUT /queues/{queue}/dlq-config` saves `maxAge` and `maxEntries` (lowering them trims the oldest in the same transaction,
  flow-protected jobs are kept). `autoRetry: true` is still 501 and `dlq-auto-retry` stays in the unsupported list;
  `dlq-retry` and `dlq-retention` left it. Operator role, audited with route and job id, never the payload.
- SDK: `queue.retryDlq(jobId, { expectedVersion })` and `retryDlqMany({ limit, reason })` on the same store calls.
- Panel: a Retry button on each DLQ row (sends the version the page read; a flow member shows "In a flow"), "Retry up to 500"
  behind a question (disabled when the queue has no failed jobs; it says how many remain), and a "Failed job handling" card on
  queue Settings with days and count, asking before a save that deletes. A viewer sees the facts only; a server that lists
  `dlq-retry` as unsupported gets no button and one note. A second click in the same tick sends nothing (lease in
  `useDlqRetry`). `DlqPro.tsx` was split (`dlq/useDlqRetry.ts`, `dlq/exportDlq.ts`) to stay under 300 lines.
- Docs: openapi, compat, unsupported, control-api README, panel README, PORTING, DESIGN D16.
- Ran: `QCLOUD_REQUIRE_DB=1 bun test packages/control-api packages/sdk` 998 pass / 0 fail; `bun test packages/panel` 2178 pass /
  0 fail; `bun run --cwd packages/panel build` ok; `bun run security:routes` ok; typecheck, lint (no errors), format and
  architecture ok.
- UI review: web-design-guidelines rules applied to `DlqConfigForm`, `DlqPro`, `DlqProTable`, `DlqProControls`; one finding fixed
  (the "In a flow" hint is now screen-reader text, not only a `title`). Repo rules win over the guideline on two points: copy is
  sentence case, and Save is disabled while the form is invalid or unchanged (same as the other settings cards). Axe
  (Playwright, WCAG 2.2 AA) on `/dlq?queue=orders` and on queue Settings with the card open and a validation error:
  0 violations in dark and light at 1280 px, and in dark at 390 px. Checked the screenshots by eye. The Tab order reaches
  the fields.
- Not run: `bun run test:e2e` (needs the full server stack; `e2e/monitoring.e2e.ts` was edited but not executed);
  the Retry / retention card on a real server with Postgres behind it.
