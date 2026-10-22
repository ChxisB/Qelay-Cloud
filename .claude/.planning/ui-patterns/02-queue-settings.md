# V2 — Queue Settings cards

**Status:** done · **Depends on:** V1 · **Touches:** packages/panel/src/pages/control/queue, packages/panel/test, packages/panel/e2e

## Goal
Speed limit, Jobs at the same time and Stuck job detection each read as a sentence with one Edit button.

## Steps
1. Split `LimitsCards.tsx` (284 lines) into `RateLimitCard.tsx`, `ConcurrencyCard.tsx` and `limitParts.tsx` (`RemoveLimit`, `Outcome`).
2. Speed limit and Jobs at the same time: the server has no readback, so the sentence is the last value set from this page
   ("Set to 100 jobs every 60000 ms at 14:02") or "This server does not say what is set. Edit to set one." Same payloads, same confirm dialogs, same "Type the queue name" interlock.
3. Stuck job detection: sentence "A job can get stuck **3** times before it is marked failed", Edit reveals `maxStalls` and Save, the read-only facts stay below.
4. Failed job handling stays facts only (the server accepts no change); it gets a one-line sentence above the facts.
5. Update the pinned tests and e2e on purpose: a click on Edit before the field is used.

## Acceptance
- No input is visible on `/queues/:name?tab=settings` until Edit is pressed.
- Every request body and confirm message is unchanged (existing payload tests pass without loosening).
- After a successful save the card closes and its sentence shows the new value.
- Each file is 300 lines or fewer.

## Verify
```bash
LC_ALL=en_US.UTF-8 bun test packages/panel
bun run typecheck && bun run lint && bun run architecture
```

## Risks / notes
`fill` inside a closed card times out in Playwright: the e2e opens the card first.

## Result

- `RateLimitCard.tsx`, `ConcurrencyCard.tsx`, `limitParts.tsx`, `limitSentences.ts`; `LimitsCards.tsx` composes them and
  `StallForm.tsx` uses `ReadFirstCard`. `DlqConfigForm`, `LifecycleCard` and `QueueSettings` are unchanged: the DLQ card is
  facts only because the server has no write for it.
- The server has no GET for rate limit or concurrency, so those two cards say what was set from this page in this session and
  otherwise "the server does not report it". Recorded under Risks in CURRENT.md.
- Tests: `limit-sentences.test.ts`, a new describe in `control-pages-stable-fixes.test.tsx`, and
  `queue-control-audit-05` and `-06` and the blank-TTL test now press Edit first, on purpose.
- Ran: `bun test packages/panel` was 1533 pass, 0 fail after V2.
