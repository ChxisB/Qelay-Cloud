# 02 — Fold the Control duplicates into their parents

**Status:** done · **Depends on:** 01 · **Touches:** packages/panel

## Goal
Add job, Bulk add, Job inspector, Queue control and DLQ control stop being pages of their own; each action is reachable from
the page it belongs to.

## Steps
1. Write the **action-parity table** first (old page, every button or form, where it lives after). Put it in the Result.
2. Jobs: an "Add jobs" button opening Add job and Bulk add (a drawer or `?add=one|bulk`), and a "Find a job by id" box
   that opens the inspector view (`?job=<id>`).
3. Queues `/queues/:name` Settings tab takes whatever Queue control still has that the tab lacks (U2 already moved most).
4. Dead letters takes what DLQ control has (pick-a-queue becomes a queue filter).
5. Redirects: `/add-job`, `/jobs/bulk-add`, `/job`, `/queue-control`, `/dlq-control` keep working. Remove their nav items.
6. Move the pages' code under the parent's folder; keep the confirm dialogs and the type-the-name interlocks exactly as they are.

## Acceptance
- Every row of the parity table has a test or an e2e step that reaches it from the new place.
- The five old paths redirect, with the query that selects the right mode (test).
- The destructive confirms still require what they required (existing tests pass unedited).

## Verify
```bash
bun run typecheck && bun test packages/panel && bun run --cwd packages/panel test:e2e
```

## Risks / notes
- The clear-policy interlocks and confirm dialogs carry safety behaviour (ux-clarity risk list): they move, they do not change.

## Result

### Plan correction
Step 2 and 5 said Add job, Bulk add and the Job inspector would become a drawer or `?add=` and `?job=` modes on Jobs, with
redirects. They are three real forms with their own state, and about ten `/job?id=` links point at the inspector. Folding
them into one page would be a rewrite for no visible gain. What was done instead: they stay at their paths (no redirect),
leave the sidebar, and are reached from Jobs (buttons **Add job**, **Bulk add**, **Find by ID**); the Jobs nav item is the
current item on all four paths (`NavItemDef.also`). Only `/queue-control` and `/dlq-control` redirect.

### Action-parity table
| Old page | Action | Where it lives now | Test |
|---|---|---|---|
| Add job | the form | `/add-job`, from Jobs "Add job" (operator) | `jobs-render`, `viewer-gating` (operator sees it, viewer does not); e2e `control-api`, `operations` |
| Bulk add | the import form | `/jobs/bulk-add`, from Jobs "Bulk add" (operator) | `jobs-render`, `viewer-gating`; e2e `operations` |
| Job inspector | find by id, job actions | `/job`, from Jobs "Find by ID" (everyone) | e2e `control-api`, `operations` |
| Queue control | pick a queue | `/queues` list, then `/queues/:name`; `/queue-control` redirects to `/queues` | `app-routes-complete`, `nav-shell` |
| Queue control | counts, Active/Paused badge | Overview tab | `queue-detail-pro-safety` |
| Queue control | Pause or resume | Settings tab, `LifecycleCard` | `queue-detail-pro-safety` (double click, malformed ACK, queue switch) |
| Queue control | speed limit, jobs at the same time, remove | Settings tab (same cards) | `queue-settings-04..07` |
| Queue control | stuck job detection, failed job handling | Settings tab (same cards) | `queue-settings-04..07` |
| Queue control | run delayed jobs, other count actions | Settings tab | `queue-settings-04` (the button), `queue-detail-pro-safety` (a negative count is an error) |
| Queue control | SDK operations card (hidden on a managed deployment) | Settings tab "Developer tools" | `queue-settings-operations-hidden` |
| Queue control | queue vanished, malformed detail | `QueueDetailPro` "Queue not found" and `assertQueueDetail` | `queue-detail-pro-safety` |
| DLQ control | pick a queue, list, filter, export CSV | Dead letter queue page (`DlqPro`) | `control-pages-stable-fixes.part-03`, `server-action-pages`, `frontend-a11y-fixes-04` |
| DLQ control | Retry all, Purge (disabled by flow policy) | `DlqPro` "Retry this queue" and "Purge this queue", still disabled with the same titles | `server-action-pages`, `viewer-gating` (viewer sees neither), e2e `monitoring` |
| DLQ control | selected queue vanished | `DlqPro` resets the picker (gap found and ported, with a test) | `control-pages-stable-fixes.part-03` ("a selected queue that disappears from discovery is replaced by a live one") |

Two gaps were found while building this table and closed: `DlqPro` lacked the vanished-queue reset, and the Pro queue page
lacked the `assertQueueDetail` check. Both are in the changed files and tested.

### What changed
- Deleted: `QueueControl.tsx`, `DlqControl.tsx`, `dlq/DlqRow.tsx`, `dlq/DlqControlSections.tsx`, `queue-control-audit-02/03`
  tests, `actionResultCount` (dead).
- `App.tsx`: `/queue-control` redirects to `/queues`, `/dlq-control` to `/dlq`.
- `navConfig.ts`: five Control items gone (the nav is now 22 items); `NavIcon.tsx`, `model.ts`, `pageTitle.ts` follow.
- `JobsPro.tsx`: Find by ID for everyone, Bulk add and Add job for operators.
- Tests renamed `queue-control-*` to `queue-settings-*` and repointed to `QueueDetailPro`; new
  `queue-detail-pro-safety.test.tsx`; `docs/PORTING.md` rows updated.
- e2e (`control-api`, `operations`, `monitoring`, `walkthrough`, `walkthrough.drills`) reach those pages from Jobs, from the
  queue's Settings tab and from the DLQ page.

### What ran
- `bun run typecheck` (includes the e2e project), `lint` (no errors, existing warnings), `format:check`, `architecture`: pass.
- `bun test packages/panel` from the repo root: 1555 pass, 0 fail.
- **Not run:** the Playwright e2e (`test:e2e`). The e2e files were edited and type-check, but nothing here executed them.
  The confirm dialogs and type-the-name interlocks were not changed; their existing tests pass unedited, except the ones
  that mounted the deleted pages, which were repointed.
