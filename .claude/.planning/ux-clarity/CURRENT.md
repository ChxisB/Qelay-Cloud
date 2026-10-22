# UX clarity: a console anyone can understand

Requested by the owner on 2026-10-20 after using the demo: "Loads of screens really hard to understand, such as
/queues/emails. So many cards with input fields, settings etc. Inputs are miss aligned, text is all over the place. It's
really distracting on each page where it's so hard to know what is what and what is going on. Can we make the platform
super user friendly, that anyone can understand it."

## Goal
A person who has never read the Qelay docs can open any console page, say what it is for in one sentence, find the one
thing they came to do, and trust that nothing destructive happens by accident.

## Scope
- **In:** `packages/panel` only. Layout, grouping, wording, control alignment, what is shown by default.
- **Out:** engine behaviour, the Control API, `shared/flowOperationPolicy.ts`, payload keys and request shapes, auth and roles.
  No new dependency, no migration, nothing under `infra/`.
- **Touches:** `packages/panel/src/components/ui/form.tsx`, the queue pages and cards, Add job, the control pages, the
  tests that pin the old copy, DESIGN-MAP, the panel README, a completion note.

## Design impact
Fits DESIGN.md (no engine change). One deviation from the boards, recorded as DESIGN-MAP R33: fields and buttons are
both 40px, where the boards say 48px for fields and 44px for buttons (R25 already moved buttons to 40px).

## The rubric (a page is done when every line is true)
1. **Says what it is.** The page header and every card carry one plain sentence ("what this does"), written for someone
   who does not know the engine's words.
2. **Shows the current value.** A setting card shows what is set now, or "Not set", before it offers to change it.
3. **One main action per card.** One primary button; the rest are secondary. Related fields sit in one row or one stack.
4. **Everything lines up.** Fields are 40px, labels sit above, hints below; action buttons sit level with the control they
   act on, not with the hint under it. No row mixes label heights.
5. **No jargon by default.** `ms`, `TTL`, `DLQ`, `SDK`, `broker`, `lifo` are replaced by plain words or glossed in a hint
   (a unit goes in the hint: "in milliseconds, 60000 is one minute"). The request payload keys do not change.
6. **Monitoring apart from settings.** Reading ("how is this queue doing") and changing ("how should it behave") are
   different places, not one long scroll.
7. **Unavailable is said once.** A feature this server cannot do is one short note with a "Why?" disclosure, not a
   disabled form plus an orange paragraph per control.
8. **Danger is separate.** Destructive actions sit in their own labelled block. The confirm dialogs and the
   "type the queue name" interlocks stay exactly as they are.

## Status

| # | Mini-task | Depends on | Status |
|---|-----------|-----------|--------|
| U1 | Controls line up: 40px fields, `FormRow` and `FieldAction`, convert the `items-end` rows | none | done |
| U2 | Queue pages (`/queues/:name`, `/queue-control`): plain-language cards, Overview and Settings tabs, Advanced, one unavailable note | U1 | done |
| U3 | Add job and Bulk add: human labels for the options, Advanced collapsed | U1 | done |
| U4 | Server, Settings, DLQ control, Database, Webhooks, Cron | U1 | done |
| U5 | Remaining pages against the rubric | U1 | done |
| U6 | Verify: clip and route sweeps (390 and 1440), e2e with axe, full gate, DESIGN-MAP R26+, README, completion note | U1-U5 | done |

## Risks
- The clear-policy interlocks and the confirm dialogs carry safety behaviour. They move, they do not change.
- Several unit tests pin the old copy ("Lifecycle", "Replace policy", "Ensure no rate limit", "Promote delayed",
  "Queue SDK operations"). They are updated to the new copy on purpose, never loosened.
- Touch targets stay at 40px (R25, R33).
- About 43 routes: every page that changes gets the clip check and a look at 390 and 1440.

## Not decided here
The licence test failure (`test/docs/release.test.ts`, the upstream copyright line) is the owner's call and is untouched.

## Result
All six tasks are done. Checked on a scratch Postgres 18 (`QCLOUD_REQUIRE_DB=1`), Chromium only, nothing real-cloud.
- Gate: typecheck, lint (warnings only, all `set-state-in-effect` or similar from before), format and architecture clean.
  `bun test`: 5172 pass, 252 skip, 2 fail. One is the known licence test (`test/docs/release.test.ts:21`). The other is
  `read.plans.aux.test.ts` "throughput of the whole fourteen days" (planner picks a Sort): it failed 1 run in 3 in isolation
  with `store-postgres` untouched by this plan, so it is a flake to look at separately.
- e2e with axe: 35 of 35 pass, in two runs (33 first; the two stale labels, "Pause queue" / "Resume queue" and the
  "More options" opener in `walkthroughKit`, were then fixed and those two specs re-run, 6 of 6).
- Sweeps at 390 and 1440 over 43 routes: no clipped control (the 172 hits are two sr-only elements), 172 renders with 0 problems.
- Not run: Firefox and WebKit e2e, a pixel diff against the boards, a usability test with a real first-time user.
