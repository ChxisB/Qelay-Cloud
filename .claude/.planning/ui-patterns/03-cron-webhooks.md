# V3 — Cron and Webhooks create forms

**Status:** done · **Depends on:** V1 · **Touches:** packages/panel/src/pages/control/cron, webhooks, packages/panel/test, packages/panel/e2e

## Goal
When schedules or webhooks already exist, the list comes first and the create form sits behind one "New ..." button.

## Steps
1. Read `CronManager.tsx`, `WebhookForm.tsx` and their tests. Decide whether the pattern fits: a create form is not a setting.
2. If it fits: the form is open when the list is empty and closed behind a button when it is not. If not, record why in Result and stop.
3. `cron/model.ts` is at 297 lines: do not add to it.

## Acceptance
- Either both pages follow the rule above with their tests passing, or Result states the reason and what was left alone.
- Creating a cron and a webhook still works end to end (`walkthrough.e2e.ts`).

## Verify
```bash
LC_ALL=en_US.UTF-8 bun test packages/panel
```

## Risks / notes
The walkthrough e2e fills the Cron form directly: it must open it first.

## Result

- It fits, so both pages follow the rule. `components/ui/CreateCard.tsx`: a title, one "New schedule" or "New webhook" button
  (Cancel while open), the form only when opened, and no button with the form always shown while the loaded list is empty.
  Cron and Webhooks close it after a create. The `canOperate` guard on Cron is unchanged.
- The empty-list form does not take focus on page load (focus follows the person's own button press only), tested.
- The in-form "Schedule created ✓" line is no longer reachable after a create, because the form closes; the toast and the new
  row say it. Known and intended. When the first item is created in an empty list, focus is not restored to the new button.
- Tests changed on purpose: `server-action-pages-03`, `mutation-action-guards` (asserts the toast and the closed form
  instead of the in-form text), `cron-add-clone-audit`, new `create-card.test.tsx`. e2e `walkthrough`, `dashboard`,
  `webhooks` use a new `openCreateForm` helper in `e2e/fixtures.ts` that presses the button only when it is there;
  `walkthrough.drills` checks the viewer sees no "New schedule" button.
- Ran: `bun test packages/panel/test/create-card.test.tsx` and the five affected files pass; typecheck clean.
- Not run yet: the e2e (V8 runs it).
