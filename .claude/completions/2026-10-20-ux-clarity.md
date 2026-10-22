# 2026-10-20 — UX clarity: a console anyone can understand

Requested by the owner after using the demo ("Loads of screens really hard to understand, such as /queues/emails. So many
cards with input fields, settings etc. ... inputs are miss aligned, text is all over the place ... Can we make the platform
super user friendly, that anyone can understand it"). Plan: `.claude/.planning/ux-clarity/CURRENT.md`, tasks U1 to U6.
`packages/panel` only: no engine change, no Control API change, no payload key changed. Nothing is committed, pushed or published.

## Changed
- **Alignment (U1).** `components/ui/form.tsx`: labels are `leading-5` with an 8px gap, controls are 40px, `FormRow` is
  `items-start`, `FieldAction` (`mt-7 min-h-10`) lines a button up with the control. Every `items-end` form row was converted.
  `SegmentedControl` takes `format`, `asWritten` and `label`.
- **New primitives.** `Disclosure.tsx` (native `<details>`) and `Facts.tsx` (read-only label and value rows).
- **Queue pages (U2).** `/queues/:name` has Overview and Settings tabs; `/queue-control` uses the same cards. Each card says
  what it is, shows the current value and has one main action: Pause or resume, Run delayed jobs now, Speed limit, Jobs at
  the same time, Stuck job detection, Failed job handling. Removing a limit is behind a "Remove ..." disclosure with the
  "Type the queue name" interlock unchanged. Unavailable clean-up is said once, with a "Why?" disclosure.
- **Add job and Bulk add (U3).** Human labels for the options, Advanced options collapsed, units in hints.
- **Server, Settings, DLQ control, Database, Webhooks, Cron (U4).** Plain labels and hints, presets behind a disclosure,
  one unavailable note on DLQ control and Dead letter queue (`dlq/DlqUnavailableNote.tsx`), Database filter wording.
- **Remaining pages (U5).** Job inspector actions say once what is switched off and why; classic queue page, Benchmark,
  MCP, Flows and Workflows copy; page titles and labels recased to sentence case to match the nav (R32).
- **Docs.** DESIGN-MAP R26 to R33, the panel README "Look and feel", the `QueueDetailPro` doc comment, this note.

## Behaviour changes to sign off
- **Read-only DLQ and stall settings.** The server accepts only `maxStalls` for stall config and has no DLQ config write,
  so those cards show facts, not inputs. Rate limit and concurrency stay Apply and Remove only.
- **The `durable` toggle is gone from Add job.** Postgres ignores it. The form model and the bulk-add parser still accept the key, and it is sent only when set.
- **40px controls** against the boards' 48px fields and 44px buttons (R33).
- **Pinned tests and e2e labels changed on purpose**, never loosened: the queue-page copy, Cron, webhook groups, DLQ copy
  and the sentence-case titles (`flow-page`, `alerts-stores-fixes`, `page-tables-11` and the e2e `monitoring`, `flows`,
  `walkthrough`, `control-api`, `all-routes`, `walkthroughKit`). `walkthroughKit` opens "More options" before it fills a field.
- **Number format** is pinned to `de-DE` (existing), so tests match `/10[.,]000/`.
- **Nav labels** are the design's and were not reworded; plain-language glosses live in page descriptions.

## Checked
Scratch Postgres 18 on 127.0.0.1:55442 with `QCLOUD_REQUIRE_DB=1`, Chromium only, no real cloud resource touched.
- **Gate.** typecheck, lint (warnings only), format check and architecture are clean. `bun test`: 5172 pass, 252 skip, 2 fail.
  - `test/docs/release.test.ts:21`: the licence file still carries the upstream "Copyright (c) 2024 Egeo Minotti" line. Known, fails at HEAD, the owner's decision.
  - `packages/store-postgres/test/read.plans.aux.test.ts` "throughput of the whole fourteen days": the planner chose a Sort. It failed 1 run in 3 in isolation and passed the other 2. This plan does not touch `store-postgres`, so it is a flake to look at separately.
- **File cap.** `cron/model.ts` hit 301 lines; the interval message was shortened to "Enter how often to run" (297 lines).
- **e2e with axe:** 35 of 35 pass, in two runs. The first run had 2 failures from labels the e2e had never been run against: the Pause and Resume buttons are now "Pause queue" and "Resume queue", and `walkthroughKit` now opens "More options" only when the field it fills is hidden. Those two specs were re-run (6 of 6).
- **Unit tests:** `LC_ALL=en_US.UTF-8 bun test packages/panel` was 1526 pass, 0 fail after the last copy change.
- **Headless Chromium, 43 routes at 390 and 1440 wide:** no clipped select, button or table head. The 172 hits are two sr-only elements ("Skip to content" and the node switcher's "Active node" label). Route sweep: 172 renders, 0 problems.

## Owed or not run
- Firefox and WebKit e2e, a pixel diff against the boards, and a try-out with a real first-time user.
- `DlqProTable.tsx` still has `text-xs` cells. The DLQ control table scrolls sideways at 1280 wide and below.
- "Dead Letter" in `MetricsStatusPanels.tsx` and the "hosted qelay Cloud" line in the Alerts copy were left as written.
- Some hint wording (what a setting does on the server) is unverified against the engine; check it before release.
- The scratch Playwright config used for e2e (the installed Chromium is not the revision Playwright 1.62.1 asks for) was deleted.
