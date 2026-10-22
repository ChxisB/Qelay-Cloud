# Design map: boards, pages, and where the panel differs

Read from the canvas "Design" (Claude Design, version `1792625519-cabd`, read 2026-10-22):
https://claude.ai/artifact/TMMbZ97jDRzvSpWiFVKRuG. The owner re-saved it under their own account; it holds the same content as
the earlier canvas (38mjPuVmfty4i3nmdeDkPo, version 21, now superseded): byte-identical in nine files, serialisation-only
differences in the rest, no wording, layout or logic change. It is private until the owner shares it from the page's Share menu.

Phase 3 reads a board with `Artifact action:"read", url:"https://claude.ai/artifact/TMMbZ97jDRzvSpWiFVKRuG",
paths:["project/<file>"]`. The files carry random suffixes:

| Board | File | Board | File |
|-------|------|-------|------|
| Main | `Main-gdju.dc.html` | Work | `Work-kk0m.dc.html` |
| ConnectionStates | `ConnectionStates-sozk.dc.html` | Automation | `Automation-oyhl.dc.html` |
| ConnectionPage | `ConnectionPage-bnx7.dc.html` | Monitor | `Monitor-o4qh.dc.html` |
| GatewayEvents | `GatewayEvents-uwli.dc.html` | Health | `Health-zkin.dc.html` |
| GatewayMore | `GatewayMore-quzh.dc.html` | System | `System-ux68.dc.html` |
| Motion | `Motion-a0w6.dc.html` | SystemMore | `SystemMore-29bv.dc.html` |
| Language | `Language-u5ho.dc.html` | States | `States-mfeg.dc.html` |
| Shell | `Shell-e8lp.dc.html` | Home | `Home-r37y.dc.html` |

Support files (`qelay.css`, `qmotion.css`, `qnav2.js`) are unchanged; `qmotion.css` is the source for the motion values.
It is built from the Design type, the Carebell design system and the earlier console canvas, and reuses their stylesheet
(`qelay.css`) plus one new one (`qmotion.css`) and a nav script (`qnav2.js`). The boards use classes; the panel uses Tailwind
utilities and small React primitives, so the design is ported as primitives and token values, not as a copy of the stylesheet.

**All names, queues, addresses, figures, times and error texts on the boards are sample.** Labels (nav, tabs, states, buttons,
rule names, count words) are the panel's own. The Hookdeck screenshots gave layout and behaviour only.

How it was checked: the boards were audited with a Node script (alias fields, boolean conditions, holes) and every handler was
called three times. **Nothing was rendered or screenshotted**, so spacing, wrapping and motion timing are not seen by eye yet.

## Board to page

| Board | Route | Panel file | Task |
|-------|-------|-----------|------|
| Motion | (rules and tokens) | `src/tokens.css`, `src/index.css`, `lib/usePresence.ts` (new) | 01, 02 |
| Connected language | (node, line, pill, rule glyphs, hover card) | `components/ui/nodegraph/*` | 03 |
| Shell and overlays | shell, palette, drawers, confirm, toasts | `components/layout/*`, `CommandPalette*`, `ui/ConfirmDialog.tsx` (new), `ui/Toaster.tsx`, `globalModalStore.ts` | 04 |
| Connections (Main) | `/events-gateway` | `pages/control/gateway/Connections.tsx`, `ConnectionRow.tsx`, `ConnectionsTable.tsx` | 06 |
| Connection states | the same, every state and the phone | same, plus `ui/feedback.tsx` | 06 |
| Connection page | `/events-gateway/connections/new`, `/connections/:id` (overview, metrics, settings) | `CreateConnection.tsx`, `ConnectionPage.tsx`, `ConnectionOverview.tsx`, `ConnectionSettings.tsx`, `ConnectionForm.tsx` | 07 |
| Gateway events | `/events-gateway/events`, `/issues` | `Events.tsx`, `EventDetail.tsx`, `EventTimeline.tsx`, `Issues.tsx`, `IssueCard.tsx` | 08 |
| Gateway more | `/events-gateway/destinations`, `/metrics` | `Destinations.tsx`, `DestinationForm.tsx`, `Metrics.tsx`, `MetricsParts.tsx` | 08 |
| Home | `/` | `pages/control/OverviewPro.tsx`, `overview/*`, `home/*` | 09a, 09b |
| Work | `/queues`, `/queues/:name`, `/jobs`, `/job`, `/dlq` | `QueuesOverview.tsx`, `QueueDetailPro.tsx`, `JobsPro.tsx`, `jobInspector/*`, `DlqPro.tsx` | 10 |
| Automation | `/cron`, `/flows`, `/workflows` | `CronManager.tsx`, `features/flows/ui/*`, `features/workflows/ui/*` | 11 |
| Monitor | `/metrics`, `/workers`, `/logs`, `/alerts` | `MetricsPro.tsx`, `WorkersPro.tsx`, `LogsPro.tsx`, `pages/Alerts.tsx` | 12 |
| Health | `/deployment`, `/diagnostics`, `/transport`, `/usage` | `Deployment.tsx`, `Diagnostics.tsx`, `Transport.tsx`, `UsagePro.tsx` | 13 |
| System | `/server`, `/database`, `/s3`, `/mcp` | `ServerControl.tsx`, `Database.tsx`, `S3BackupPro.tsx`, `McpServer.tsx` | 13 |
| System more | `/benchmark`, `/fleet`, `/settings` | `Benchmark.tsx`, `pages/Fleet.tsx`, `pages/Settings.tsx` | 13 |
| States | sign-in, config error, token lock, `*`, not available, route check, crash, offline strip | `components/AuthScreens.tsx`, `AuthGate.tsx`, `pages/NotFound.tsx`, `NotAvailable.tsx`, `RouteGate.tsx`, `ErrorBoundary.tsx`, `ui/feedback.tsx`, `ui/Banner.tsx` | 05, 13 |

**Not drawn:** `/add-job` and `/jobs/bulk-add` have no board of their own. They take the shared primitives (press, focus,
field errors, toast, confirm) from tasks 02, 04 and 05 and nothing page-specific. The redirects (`/webhooks`, `*-classic`,
`/queue-control` and the others in `App.tsx`) draw nothing.

## Task split: what the boards change

16 boards instead of the 15 mini-tasks in CURRENT.md's first proposal. Task 13 would carry four boards (Health, System, System
more, States) and about 14 routes, so Phase 2 splits it: 13a Health, 13b System, 13c Benchmark, Fleet and Settings, 13d auth and
page states. Task 12 stays one (four routes, one board). Everything else keeps its number.

## Rules the boards follow (so a task does not re-decide them)

- Only `transform` and `opacity` move. Colour changes on state are plain colour transitions. The SVG line draw and the bar fill
  use `scaleX` or a dash, never width or height.
- Everything new sits inside `prefers-reduced-motion: no-preference`. The reduce rule in `index.css` stays as the backstop.
- Enter 300 ms, exit 180 ms, press 160 ms, hover 240 ms, stagger 40 ms and never past 8 items, line draw 600 ms, one-shot pulse
  900 ms. A leaving surface stays mounted for 180 ms through `lib/usePresence.ts`.
- A pulse or a flash fires only when a poll found a changed value. Idle lines and unchanged polls stay still. The skeleton is the
  only loop. No fake traffic and no claim of "live" beyond the poll.
- Animation never blocks input, and every cue also exists in words or a glyph (`role=status`, a word beside the colour).
- Controls for actions that `shared/flowOperationPolicy.ts` gates off are not drawn (see W5 and H6).

### Non-colour tokens (approved 2026-10-22; no light and dark pair)

| Token | Value | Use |
|-------|-------|-----|
| `--duration-press` | 160ms | press and focus colour |
| `--duration-hover` | 240ms | hover, card settle |
| `--dur-enter` | 300ms | anything arriving |
| `--dur-exit` | 180ms | anything leaving |
| `--dur-stagger` | 40ms (cap 8) | list arrival |
| `--dur-draw` | 600ms | line and chart draw-in |
| `--dur-flow` | 900ms | the one-shot comet along a line |
| `--ease-settle` | `cubic-bezier(.22,1,.36,1)` | default |
| `--ease-exit` | `cubic-bezier(.4,0,1,1)` | leaves |
| `--ease-pop` | `cubic-bezier(.34,1.56,.64,1)` | small switches and the lock card only |

No new colour, font or package. Motion is CSS transitions and keyframes, `@starting-style`, React Router `viewTransition`, an
SVG or `scaleX` draw and the presence hook.

## Deviations

Each is numbered by its board. **Home** and **Health** both use `H1` to `H5` on their boards, so they are written "Home H1" and
"Health H1" here. The gateway boards carry no numbers on the page; G1 to G8 are written from their notes for this map.

### Shell and overlays (task 04)
- **S1** The sidebar highlight is shared and slides, from one layout read on mount and on a fold. Reduced motion and no script fall back to today's wash.
- **S2** The browser's confirm box goes. A new confirm owner in the modal store (priority 90) replaces the 27 `window.confirm` calls. **This is the one deviation that touches behaviour:** the answer arrives asynchronously, and tests that stub `window.confirm` change in the task that moves each call. Approved 2026-10-22.
- **S3** Health gets a spoken line, shown and announced only when a poll changes the state.
- **S4** Every overlay gets a 180 ms exit through the presence hook.
- **S5** A loaded drawer value fades in. No new request.
- **S6** Alerts shows a count dot and "Alerts, 3 triggered" in its name. The count is data the panel already has.

### Event gateway (tasks 06 to 08)
- **G1** The Connections page becomes a line diagram (source, line, pill, destination, 24-hour bars and figures). Today its default view is one card per source holding a table. What happens to the other views and the table is read from `Connections.tsx` in task 06; if a view would be lost, that is a stop.
- **G1 outcome (task 06, built 2026-10-22).** No view or control was lost: the Structured view is the diagram and the Table view is unchanged. Events, Send a test event and Remove connection sit in a "More" menu in the diagram. Not built from the board: the 24-hour popover, State chips with counts, a tablet layout (vertical below 1280 px), a shaped loading skeleton, "Preview a poll", and the lifetime columns in the Structured view (the Table keeps them).
- **G2** The rules card opens on hover or focus of the pill. It is an extra: a tap on a phone goes straight to the connection, and every rule is also listed on the connection page.
- **G3** A line carries only what the panel knows: the connection's own events and rules, and the last 24 hours. No bandwidth, rate or live traffic is drawn. A line holds no action; the pill is the link.
- **G4** Count words follow the panel: "Successful", "Failed", "Waiting now". Rule sentences are the panel's (`connectionRules.ts`). The "60 attempts a minute" chip is the guide's wording (`docs/webhooks.md`); the panel's own sentence is "At most 60 attempts a minute; the rest wait their turn." The chip is shorter on purpose. "Sent so far" on the connection page is the panel's label and stays.
- **G5** The new-connection page draws its line from what is typed. It shows the form, not server data, and nothing is saved until Add connection. It is new; task 07 checks `CreateConnection.tsx` for anything like it.
- **G5 outcome (task 07, built 2026-10-22).** `CreateConnection.tsx` had nothing like it, so the preview is new: a side panel "What it will do" in `ConnectionForm`, drawn from the form state with no call of its own. A missing end is a dashed placeholder that says what to choose; the line is dotted until both ends exist; a rule joins once its box holds text. The saved connection's page draws the same line (`ConnectionChain`) with a comet on a polled rise. Not built: rule switches (the page has none; rules show as a glyph and "On"), one wire per rule (one wire carries them all).
- **G6** An event's attempts draw as a line, in order. The store keeps no request or response body, so none is shown: an attempt is its time, length, the receiver's status and a reason. Square stops are failures, round ones are not.
- **G6 outcome (task 08a, built 2026-10-22).** `AttemptLine` draws the attempts as stops on a vertical line, oldest first, each with its number, Failed or Sent, time, length, HTTP code (or "no answer") and reason, and an end stop for how the event stands ("On hold" when the connection is off). Square stops are failures. The stops arrive one after the other; the line itself is not drawn in, because the draw only scales sideways. No body is shown. Issue cards draw their line too ("Still trying", "Stopped itself", "Recovered"); those three phrases are new wording.
- **G7** Destinations show one short line per connection running into the address. The count is all the panel has, so the lines carry no names. A new strip "Where events went" on Metrics is drawn from the three counts the six numbers already hold. Its heading and help line are new wording and need the owner's word.
- **G8** Under 1280 px the event detail opens as a sheet from the bottom (300 ms in, 180 ms out, Escape, scrim, focus back to the card). Task 08 reads `Events.tsx` to see what the detail does today and records any difference. Issues show the line they are about; a viewer reads and an operator moves an issue between the four tabs, as the board's note says (task 08 checks this against `Issues.tsx`).
- **G7 outcome (task 08b, built 2026-10-22).** A destination card shows up to four short lines (then "+n more") for the connections that use it, drawn from the count the panel loads; they carry no names and are hidden from a screen reader, the sentence under the address says the count. They turn dashed while the address in the edit form differs from the saved one and flash once when the saved address changes. The edit form and the new-destination form open and leave with the card; Remove asks in the page's own dialog. Metrics gains "Where events went": the total ("Events matched") and one row each for Successful, Failed and Pending with count, share and a bar, drawn from `delivered`, `failed` and `pending` of the same stats read; the counts wash on a polled change. An empty range keeps today's empty message and draws no strip. Not built: the board's "Preview a poll"; lines drawn as wires out of the strip (it uses the existing bars). New wording: "Where events went", "Events matched", "Pending" (the strip has no help line).
- **G8 outcome (task 08a, built 2026-10-22).** `Events.tsx` already opened the detail in a column beside the table. Now that column stays at 1280 px and over, and under 1280 px the same detail is a bottom sheet (`EventSheet`: scrim, Escape, Close, focus back to the row, `event-sheet` owner under the confirm). The detail's content and controls are unchanged. `Issues.tsx` already let a viewer read and an operator move an issue between tabs, so the board's note matches the code. Not built: the sliding status highlight, rows as cards on a phone, "Preview a poll".

### Home (tasks 09a, 09b)
- **Home H1** Seven tiles become one Job flow. The numbers, hints and the amber threshold (more than 100 ready) are the panel's. The heading "Job flow" and its help line are new wording and need the owner's word.
- **H1 outcome (task 09a, built 2026-10-22).** `overview/JobFlow.tsx` replaces `OverviewTiles.tsx`: Delayed feeds Ready backlog from above, push comes in from the left, Ready → Active → Completed run across, and Failed branches down from Active only while failures are recorded. It is a six-column grid from 1024 px and one column below, where Delayed and Failed sit under the column as side branches with no line. A line pulses once only when the figure it feeds changed. A screen reader gets one sentence; the lines and rate pills are hidden from it. Not built: the plan's "top strip of gateway connections" (the board has none). New wording "Job flow", "Where jobs are, as last read. The lines show direction only." and "Completed counts since the server restarted" needs the owner's word.
- **Home H2** Cards and the delivery strip get a glyph; tone was colour alone.
- **Home H3** Needs attention becomes a polite live region; a new problem is announced once.
- **Home H4** Charts and bars animate once. A poll never redraws them.
- **Home H5** The sample is not data.
- **H2 to H5 outcome (task 09b, built 2026-10-22).** The dots in the header ("Server connected") and the delivery strip, and the hint of any figure card whose tone means something (amber, red, green, active, waiting), became the state glyph beside the same words; a card with the default tone has none. The figure cards rise in one stagger when Home first shows. "Needs attention" is a polite live region: an issue rises in, a cleared one fades out in its place (it cannot be tabbed to while it leaves), and "Nothing needs attention" has the ok glyph, or the dash when a source could not be read. In Recent activity only an event that comes after the first read rises in. In Queue health the rows of the first load rise in a stagger (a row a poll adds does not), each bar segment draws once, and a count that changed washes once; a poll that changes nothing restarts nothing. The chart keeps its task 05 draw-in. Not built: the phone collapse of "Needs attention" (the list holds only open problems, so it stays short; deviation); a glyph in place of the dot on each Recent activity row (the row already says "started", "queued" or "completed" in words). The board's 240 ms rise is the 300 ms `--dur-enter` token (deviation). No new wording.

### Work (task 10)
- **W1** A lifecycle strip is new on the queue page, from counts it already reads. The heading "Where this queue's jobs are" and its help line need the owner's word.
- **W2** Pause all, Resume all, Promote and Run delayed jobs now ask in the page (S2). The titles, bodies and button names are proposed wording.
- **W3** Queue page tiles use the Jobs words ("Flow-blocked") instead of raw keys.
- **W4** The job Timeline draws as a line over the same events; today's list of rows stays under it.
- **W5** Controls for gated actions are not drawn (Retry all, Purge all, Retry unavailable on the dead letter queue). The note and its "Why?" stay. No retry, remove, cancel, discard, purge, clean, drain, obliterate or requeue control exists on the generic job and queue surfaces.
- **W6** Row actions carry the queue or job in their name ("Pause queue, orders").
- **W7** The sample is not data.
- **W1 to W3 and W6 outcome (task 10a, built 2026-10-22).** The queue page has the lifecycle diagram (Ready, Active, Completed, with Delayed above Ready and Failed below Active only while some are recorded), built from the six counts the page already reads; it uses the Home flow's node and line, and a line pulses once only when the count on it really changed. The Overview and Settings choice is now `LinkTabs` with the shared sliding underline (deviation: the tabs are addresses, so each one pushes a history entry where the old control replaced it). The tiles say "Waiting", "Prioritized", "Flow-blocked" and so on (W3). The pause and resume button in the queues table names its queue (W6). Queues table rows rise in a stagger on first load only, every count is washed when a poll changes it and on nothing else, and the priority bars draw once. W2: Pause all, Resume all, Run delayed jobs, Apply speed limit, Remove speed limit, Apply cap and Remove cap ask in the page; the button is the action's own verb and the two removals are drawn as dangerous. The question texts are the old `window.confirm` texts, unchanged. Not built: a depth meter in the queues table (the board has none there). Needs the owner's word: the diagram heading "Where this queue's jobs are" and its help line "As last read. A line pulses once when a count on it changes."; the seven confirm button names.
- **W2, W4 and W6 outcome (task 10b, built 2026-10-22).** Promote asks in the page from the bulk bar ("Promote 3 delayed jobs?", button "Promote 3"), from a row and from the job's own page ("Promote this job?", button "Promote"); the old page ran it with no question, so this is new behaviour. Clear logs asks too (the old `window.confirm` text, unchanged). Row actions name the job by the last four characters of its id ("Select job f340", "Inspect job f340", "Promote job f340"), and the select-all box says "Select all jobs on this page". Job rows rise in a stagger on first load only; the state tab counts wash only when a poll changes them; the selection bar drops in. The job timeline is one vertical line with a glyph per entry that arrive in order (the board is horizontal on wide screens with up to five events; the panel keeps up to 20). Deviations: no job path or `ConnectionLine` in the inspector (the board has none); the timeline stays vertical at every width. Needs the owner's word: the new Promote question texts.
- **W5 outcome (task 10c, built 2026-10-22).** The DLQ page draws no Retry all, Purge all, Retry this queue, Purge this queue or per-row "Retry unavailable" button, and no Actions column: the server has neither action. The note that says so, with "Why?", stays. "DLQ by queue" is a group of queue pills (`aria-pressed` marks the chosen one) with counts that wash only when a poll changes them, under a card that says "Pick a queue to see only its jobs." Rows rise in a stagger on first load only. Bulk add asks in the page before a picked file replaces typed input (`Replace the current input with "<file>"?`, button "Replace"); a cancel keeps the input. Needs the owner's word: nothing new in wording (the question is the old `window.confirm` text). Deviation: the id column keeps the full job id as one link (the board splits it into a dim head, a bright tail and the queue name; the page lists one queue at a time, so the queue name would repeat on every row).

### Automation (task 11)
- **A1** Creating and deleting a schedule ask in the page (S2); the create sentence keeps the same-name warning.
- **A2** The create form gains a "what this will do" line and shows Next runs as three chips. The line and the "Runs every 30 s" preview are new wording and need the owner's word.
- **A3** Row actions carry the cron name; the Unicode tick becomes the check glyph.
- **A4** The graph moves, the data does not: lines draw once, a stuck line is red, the panel swaps with a fade. The board opens with the stuck job selected; the panel opens with none.
- **A5** **Owner to confirm:** Flows explorer actions (Retry all failed, Retry this job, Release this parent, Remove flow) are kept as today. They use the version-checked flow route, not the gated generic job actions.
- **A6** **Owner to confirm:** workflow run actions (Send signal, Cancel run, Retry rollback, Abandon rollback, Recover) are kept as today, on their own version-checked route. Only motion is added.
- **A2/A3 outcome (task 11a, built 2026-10-22).** Delete and Create ask in the page with the old sentences (`Delete cron "<name>"?`, `Create the schedule "<name>"?`; the create detail keeps the same-name warning). The Queue cell of each row draws a short line that sends a comet when the run count rises; Runs washes only on a real change; rows of the first load rise in a stagger and a deleted row leaves. The form gains a "What this will do" group (schedule, line, queue, and `Adds a "<job>" job to the queue each time the schedule fires.`) and Next runs as chips. Needs the owner's word: that group and its placeholders "not set yet" and "choose a queue" (the placeholders are the board's). Deviations: the table shows the mini line, not a node pair per row (as the board does); `CreateCard` keeps its own open/close, no `usePresence`.
- **A4 outcome (task 11b, built 2026-10-22).** The flow graph's jobs and lines arrive in graph order on the first load only; a job whose state changes washes its state word once and the line into it draws again; a poll that changes nothing animates nothing. The workflow chain and step timeline do the same (first load in order; a run that moves on marks only the node it left and the node it reached). The Flows and Executions lists rise in a stagger on first load, and the Jobs count and Node number wash only on a real change. A5 and A6 are untouched: same actions, same confirms, same text. Deviations: the "comet" along an edge is a re-draw of the line (the motion guard allows only `transform` and `opacity`, so nothing can travel an SVG path); the state wash sits on the state word, not on a ring round the glyph; the timeline has no dot pop (it would be invisible after the first step). Needs the owner's word: nothing new in wording.
- **A7** The sample is not data. Three parts were not read and are shown as samples: the node detail, the payload view and the fan-out view.

### Monitor (task 12)
- **M1** Charts draw in on first load (600 ms) and slide one step (300 ms, transform only) on a real poll. The success meter fills once.
- **M2** Cells flash only on a real change. Total failed, Stale, Quarantined and the slow-p99 row carry a glyph and a word as well as colour.
- **M3** Removing a worker record and deleting an alert rule ask in the page (S2). The alert line is new wording.
- **M4** The Unicode tick after "Removed stale registry record" becomes the check glyph.
- **M5** The rule switch shows a word ("Enabled", "Disabled") and is named for its rule.
- **M6** One sentence is reworded: "Qelay has no alerting backend, so email, webhook or Slack delivery still needs your own monitoring." The panel's banner names "qelay OSS" and "hosted qelay Cloud". Needs the owner's word.
- **M7** New log lines slide in. Pause and "Resume — N new" behave as today.
- **M8** The sample is not data.
- **M1, M2, M7 outcome (task 12a, built 2026-10-22).** Charts, the success meter and the stat cards already drew in, stepped and washed from tasks 02 and 05; this task adds the rest. Per-queue counts, the two rates and the Server overview rows wash only on a real change (uptime and the latency averages and percentiles never do). Total failed and a slow p99 carry a glyph and a word ("slow 180ms"). New log lines slide in newest first, up to 8 per update, and only lines that arrived since the last update; a paused view, a search and a reconnect animate nothing. Stale and Quarantined move to 12b with the Workers page. Needs the owner's word: nothing beyond the word "slow".
- **M2 to M6 outcome (task 12b, built 2026-10-22).** Removing a worker record and deleting an alert rule ask in the page (`Remove the stale registry record for worker "X"?` with "Remove record"; `Delete alert rule "X"?` with "Delete rule"), then call the same API as before. Stale and Quarantined carry a glyph and a word. Worker counts wash only on a real change, rows of the first load rise in a stagger and a removed row leaves. The rule switch shows "Enabled" or "Disabled" and is named `Disable rule X` / `Enable rule X`; firing rows rise in and leave when the breach clears; the Unicode tick is a check glyph; the banner sentence is the board's. Deviations: no worker node and line, since Queues stays a text column as on the board; "Worker removed" stays until the next action; the last worker's row does not animate out. `useLeavers` now follows the new order of its list. Needs the owner's word: the alert-delete detail line, "Remove record", "Delete rule", the M6 sentence and the status notes ("Rule "X" is disabled.", "Deleted rule "X".", "Saved rule "X". It is checked straight away.").

### Health (task 13a)
- **Health H1** Severity, verdict and probe states keep a glyph and a word.
- **Health H2** A delivery line above the Job delivery table is new. It draws totals of the table below it and nothing else, says "unknown" where it does not know, and says "of the queues shown" when the table is cut off.
- **Health H3** Meters fill once and then move on a change; warnings rise in order. A critical warning stays `role="alert"`.
- **Health H4** Figures flash only on a real poll change; "Ns ago" updates silently.
- **Health H5** Ping, Compact (GC) and heap results animate in. Nothing about what these actions do changes.
- **Health H6** No redrive or retry control, by design. Failed notifications stay read-only and operator-only.
- **Health H7** The switches above each frame are a board device.
- **Health H8** The sample is not data.
- **Health outcome (task 13a, built 2026-10-22).** Warnings rise in order (critical first, still `role="alert"`), a later one rises alone and a cleared one leaves before "No warnings." shows. Text figures on Deployment, Job delivery, Diagnostics and Usage wash once on a real poll change; an age, a timing or an uptime that moves each poll is steady and never washes. The delivery line (Ready to run, In queue service, Picked up, with "not told yet" and "given up on" lines) is drawn above the Job delivery table from that table's rows only: any unknown row makes the total "unknown", a cut-off table says "the queues shown", and a queue service that does not count picked-up jobs shows "not reported". The board put it on Usage in the plan text; it sits on Job delivery. Deployment draws no chain (its cards keep their layout). "(Ns ago)" updates per poll, not per second. The picked-up hint says "From the queue service", not the board's "From the database". Ping, Compact (GC) and heap results animate in. Needs the owner's word: the delivery line's heading "How a job gets to a worker" and its sub text, "not reported", "N of M queues did not answer", "Maintenance is behind.".

### System (task 13b)
- **SY1** Stop, Restart and Save & restart ask in the page, with the same blast-radius wording. The Save & restart, Apply ("Apply the configuration?") and Create-a-backup ("Create a backup now?") titles are new wording, and so may be others on the board; they need the owner's word.
- **SY2** The halo around the running dot plays once. The panel loops it without end.
- **SY3** Uptime moves on without a flash. Memory and connection counts flash only on change.
- **SY4** Server states keep a glyph and a word.
- **SY5** The log tail slides new lines in. Follow and Times work as today.
- **SY6** Database has no write control, by design. Export and the row drawer stay.
- **SY7** Restore keeps its typed word, now asked in the dialog; the button stays dimmed until it matches. Restore stays unavailable while the managed server is running.
- **SY8** MCP keeps its "destructive tools" warning. The sample path reads `./data/qelay.db`; the tool total is counted from the groups shown.
- **SY9** The switches above each frame are a board device.
- **SY10** The sample is not data.
- **System outcome (task 13b, built 2026-10-22).** Stop, Restart, Save & restart, Apply, Backup now, Restore, Remove key and Trim journal ask in the page, then call the same API as before. Stop and Restart name what they drop (`This drops N TCP / M WS connections; in-flight jobs are interrupted.`); Save & restart names the fields that changed and is only asked when the draft is valid; Restore asks for the typed word `RESTORE` in the dialog and, after the answer, checks again that the managed server is stopped and the database path is the same. The halo rings once when the server turns healthy (not on a page that opens on a healthy server, not on unchanged polls); Memory and Connections wash only on a real change and the uptime never does; new log lines slide in, at most 8 per poll, and only lines that arrived since the last poll (first load, a filter, Times and a quiet poll animate nothing). The MCP sample path reads `./data/qelay.db`. SY4 and SY6 needed no change. Known limit: after an arrival, flipping the stream filter can replay up to 8 of the just-arrived lines. Needs the owner's word: "Save and restart the server?", "Apply the configuration?", "Create a backup now?", "Restore this backup?", "Remove the deduplication key?", "Trim the lifecycle journal?" and the labels "Save & restart", "Apply configuration", "Backup now", "Restore", "Remove key", "Trim journal".

### Benchmark, Fleet and Settings (task 13c)
- **SX1** Run, Clean, Stop node, Restart node and Remove ask in the page. The bodies are the panel's sentences; the titles are new wording.
- **SX2** **Owner to confirm:** Clean is not gated. It acts only on the dedicated benchmark queue this browser session owns, and stays with its confirm moved into the page.
- **SX3** Bars fill with a slide (`scaleX`), not by animating width. The throughput line draws once.
- **SX4** Group labels are bold sentence case; the panel draws them in tracked capitals.
- **SX5** The run history on the board is a sample.
- **SX6** A value over its limit is drawn with a red field and a dimmed Run. The limits and hints are the panel's.
- **SX7** Node health keeps a glyph and a word; "active" is a word, not only a border.
- **SX8** Tokens are never shown or kept: the field shows bullets, Show and Hide only swap the field's type, and nothing is stored.
- **SX9** The switches above each frame are a board device.
- **SX10** The sample is not data.
- **Benchmark, Fleet and Settings outcome (task 13c, built 2026-10-22).** Run, Clean, Stop node, Restart node and Remove ask in the page, then call the same API as before; Cancel and Escape change nothing. Run keeps its target URL and its "safety preflight will refuse" warning word for word, and Clean still refuses any queue the session does not own before it asks. A value over its limit now turns its field red (`aria-invalid`) and dims Run (`aria-disabled`, the click is ignored); before, the page silently clamped it. Under-minimum values are not flagged. The progress bars fill with `scaleX` on a full-width bar (SX3), the Clean result and the run-history rows rise in, the group labels are bold sentence case (SX4). Fleet cards rise in turn on the first load only, a node added later does not, the node border colour eases when "active" moves, only a reading that changed washes, "Refresh all" is `aria-disabled` and says "Refreshing…" until the poll settles, the loading state says what it is doing and shows placeholders, and a failed refresh keeps the cards already read under the banner. Settings needed no change for SX8: the token fields were already `type=password`, Show and Hide only swap that and the label, and nothing is kept. Needs the owner's word: "Run the benchmark?" / "Run benchmark", "Clean the benchmark queue?" / "Clean queue", "Stop this node?" / "Stop node", "Restart this node?" / "Restart node", "Remove this connection?" / "Remove", and the over-limit block in place of the clamp.

### States and sign in (task 13d)
- **SS1** New motion: the card rise, the text crossfade, the dialog's enter and exit, and the strip's enter and leave. Reduced motion turns each into an instant change. Needs the owner's word.
- **SS2** The token lock is as strict as today: no Escape, no close mark, no click outside; Unlock stays off until there is text.
- **SS3** The board draws the brand mark from the shell's ring and dot; the panel keeps its logo component.
- **SS4** The 404 numeral is decoration, hidden from a screen reader. Check that the panel does the same.
- **SS5** The switches and the "Next poll" buttons are a board device.
- **SS6** Retry behaves differently on the board: "Could not open" always fails again, "Crash" only says it reloads, and the strip's Retry succeeds after 700 ms.
- **SS7** Sample content: the server address, HTTP codes, crash sentence and the key and value inside two config messages.
- **SS8** The offline strip keeps its glyph, word and sentence; it gains enter and leave motion only.
- **SS9** The sample is not data.
- **States and sign in outcome (task 13d, built 2026-10-22).** The sign-in and config-error card rises once, and its text (the title and what is under it) is keyed by the title, so it fades in again when the screen changes under the card; the card itself is not replayed. The token lock pops in once (`motion-pop`) over its own scrim, which is no longer the container's background but a separate element, not a button, so there is still no click outside; it leaves over 180 ms (`motion-leave`, scrim `motion-fade-out`) and is `inert` while it leaves, and under reduced motion it opens and closes at once. Focus, the inert background and the draft still follow the lock the moment it is dismissed. Escape, a close mark and click outside do nothing; Unlock stays off until there is text. The empty, error, 404, not-available, route-check and crash states already took the card rise from task 05 and needed no change; the 404 numeral was already `aria-hidden`. **Two deviations, needing the owner's word:** the text change is a fade-in of the new text only, not a crossfade with the old (React replaces it); and the offline strip enters but does not leave: it is unmounted by 38 pages, and a leave that moves only `transform` and `opacity` would fade it while the content below jumps up regardless, so it disappears at once as today.

## Status of every deviation (task 14, 2026-10-22)

Built means it is in the panel as the note says; Changed means built with a difference its outcome bullet above names;
Not built means left out on purpose. Each outcome bullet above has the detail, and each task's Result has what ran.
Task 15 then looked at stills of Home, the Connections diagram, Queues, Jobs, Cron, Flows, Job delivery, Deployment, Events and
Settings in Chromium (by eye, no board beside the page; its Result lists them). No animation was watched in motion.

| Board notes | Task | Status |
|---|---|---|
| S1, S3, S6 | 04a | Built. S3 says "Control API is healthy / reachable but degraded / not answering" (the panel's three words), not the board's sample text. The route change is an own `startPageTransition`, since `BrowserRouter` ignores `viewTransition`. |
| S2, S4, S5 | 04b | Built. S2 moved all 27 `window.confirm` calls, one task at a time; `test/native-dialog-guard.test.ts` now fails if one returns. Toast rise is 300 ms / 8 px, not the board's 240 ms / 6 px. |
| G1 | 06 | Built (Structured view is the diagram, Table view unchanged). Not built: the 24-hour popover, state chips with counts, a tablet layout, a shaped skeleton, "Preview a poll", lifetime columns in the Structured view. |
| G2, G3, G4 | 03, 06 | Built. A tap does not open the rules card. A line carries no bandwidth or rate. G4 keeps the guide's "60 attempts a minute" chip. |
| G5 | 07 | Built as a new side panel "What it will do". Not built: rule switches, one wire per rule. |
| G6 | 08a | Built. The line is not drawn in (the draw only scales sideways); its stops arrive in order. No body shown. |
| G7 | 08b | Built. Not built: "Preview a poll", lines drawn as wires out of the Metrics strip. |
| G8 | 08a | Built. Not built: the sliding status highlight, rows as cards on a phone, "Preview a poll". |
| Home H1 | 09a | Built. Not built: a top strip of gateway connections (the board has none). |
| Home H2 to H5 | 09b | Built. Changed: rise is 300 ms (token), not 240 ms. Not built: the phone collapse of "Needs attention", a glyph on each Recent activity row. |
| W1, W2, W3, W6 | 10a | Built. Changed: queue tabs are `LinkTabs`, so each pushes a history entry. Not built: a depth meter in the queues table. |
| W2, W4 | 10b | Built. New behaviour: Promote asks first. Changed: the job timeline stays vertical at every width; no `ConnectionLine` in the inspector. |
| W5 | 10c | Built by leaving controls out: no Retry all, Purge all, Retry unavailable or Actions column. Changed: the id column keeps the full id as one link. |
| W7, A7, M8, Health H8, SY10, SX10, SS9 | all | Sample content, never used as data. |
| A1, A2, A3 | 11a | Built. Changed: the Queue cell draws a mini line, not a node pair per row; `CreateCard` keeps its own open and close. |
| A4 | 11b | Built. Changed: the "comet" along an edge is a re-draw of the line (only `transform` and `opacity` may move); the wash sits on the state word; no dot pop on the timeline. |
| A5, A6 | 11b | Kept as today (approved 2026-10-22). Motion only. |
| M1, M2, M7 | 12a | Built. Stale and Quarantined went to 12b. |
| M2 to M6 | 12b | Built. Changed: no worker node and line; "Worker removed" stays until the next action; the last worker's row does not animate out. |
| Health H1 to H5 | 13a | Built. Changed: the delivery line sits on Job delivery, not Usage; "(Ns ago)" updates per poll; the picked-up hint says "From the queue service". Not built: a Deployment chain. |
| Health H6, H7 | 13a | By design / board device: no redrive control; the switches above each frame are not built. |
| SY1 to SY5, SY7, SY8 | 13b | Built. Known limit: flipping the log stream filter after an arrival can replay up to 8 just-arrived lines. |
| SY6, SY9 | 13b | By design / board device: Database has no write control; no switches. |
| SX1, SX3, SX4, SX6, SX7 | 13c | Built. Changed (SX6): a value over its limit is blocked (red field, dimmed Run), where the page used to clamp it silently. |
| SX2 | 13c | Kept as today (approved 2026-10-22): Clean confirms in the page. |
| SX5, SX8, SX9 | 13c | Run history is a sample; tokens were already never shown or kept (no change); no switches. |
| SS1, SS2, SS4, SS8 | 13d | Built. Changed (SS1): the new text fades in, with no crossfade out of the old; (SS8): the offline strip enters but does not leave. |
| SS3, SS5, SS6, SS7 | 13d | Not built or not copied: the panel keeps its logo component, no switches or "Next poll" buttons, its own Retry, and the board's sample content. |

Owed to the owner's word before release: the new wording listed under the outcomes of Home H1, W1, W2, A2, M3, M6, SY1, SX1,
G7, Health H2 and SS1; the deviations Changed above for SX6 (block in place of the clamp), SS1 (fade-in, not crossfade) and
SS8 (no leave); and A2, 12b, 13a to 13d as a whole.

## What the boards do not show, and is carried into the build

- Fleet "Refresh all" is `aria-disabled` while it runs; the Fleet error page draws the banner with an empty node grid.
- No board draws a hover state for every control, only the shared press and hover rule on the Motion board.
- Animation replay on re-render, controlled password input focus, and the heights of the long boards were not seen in a browser.
  Task 15 looked at stills only; its Result lists what is still unseen.

## Approved by the owner on 2026-10-22 ("yes"), before Phase 2

1. The design as a whole, and the new non-colour tokens above.
2. **S2:** the in-page confirm replacing `window.confirm` (it changes behaviour, and tests that stub `window.confirm`).
3. **A5, A6, SX2:** the three actions kept as today although they sit near the gated ones.
4. New wording: Home H1, W1, W2, A2, M3, M6, SY1, SX1, G7 (the strip heading and help line).
5. **G1:** if reading `Connections.tsx` shows a view the line diagram would drop, this stops for a decision.
