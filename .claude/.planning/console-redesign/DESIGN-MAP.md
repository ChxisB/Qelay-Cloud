# Design map: boards, pages, and where the panel differs

Read from the design's `canvas.json`, `qelay.css`, `qnav.js`, `ds/carebell/tokens.json` and the boards, on 2026-10-20.
Boards are 1440 wide and use one stylesheet, `qelay.css`, scoped under `.app` (dark by default, `[data-theme="light"]`
overrides). It uses classes (`.card`, `.btn`, `.tbl`); the panel uses Tailwind utilities and small React primitives,
so the design is ported as primitives and token values, not as a copy of the stylesheet.

## Board to page

| Board | Route | Panel file | Task |
|-------|-------|-----------|------|
| Components | (library) | `src/components/ui/*` | 03, 04, 05, 08 |
| Modals | (library) | `components/CommandPalette`, `components/copilot/*`, page modals | 07 |
| States | `*`, gates, errors | `pages/NotFound`, `components/RouteGate`, `ui/feedback`, `ErrorBoundary` | 05, 14 |
| Auth | sign-in | `components/SignInScreen`, `ConfigErrorScreen`, `AuthGate` | 14 |
| Main (now Home) | `/` | `pages/control/OverviewPro`, `pages/control/home/` | 09 |
| Fleet | `/fleet` | `pages/Fleet` | 09 |
| Queues | `/queues` | `pages/control/QueuesOverview` | 09 |
| QueueDetail | `/queues/:name` | `pages/control/QueueDetailPro` | 09 |
| Jobs | `/jobs` | `pages/control/JobsPro` | 10 |
| Dlq | `/dlq` | `pages/control/DlqPro` | 10 |
| Cron | `/cron` | `pages/control/CronManager` | 10 |
| Workflows | `/workflows` | `pages/control/Workflows` | 10 |
| Flows | `/flows` | `pages/control/Flows` | 10 |
| Metrics | `/metrics` | `pages/control/MetricsPro` | 11 |
| Workers | `/workers` | `pages/control/WorkersPro` | 11 |
| Logs | `/logs` | `pages/control/LogsPro` | 11 |
| Alerts | `/alerts` | `pages/Alerts` | 11 |
| Transport | `/transport` | `pages/control/Transport` | 11 |
| Deployment | `/deployment` | `pages/control/Deployment` | 11 |
| Server | `/server` | `pages/control/ServerControl` | 12 |
| AddJob | `/add-job` | `pages/control/AddJob` | 12 |
| BulkAdd | `/jobs/bulk-add` | `pages/control/BulkAddJobs` | 12 |
| JobInspector | `/job` | `pages/control/JobInspector` | 12 |
| QueueControl | `/queue-control` | `pages/control/QueueControl` | 12 |
| DlqControl | `/dlq-control` | `pages/control/DlqControl` | 12 |
| Webhooks (now Event gateway) | `/events-gateway` (`/webhooks` redirects) | `pages/control/gateway/` | 12 |
| Diagnostics | `/diagnostics` | `pages/control/Diagnostics` | 12 |
| Benchmark | `/benchmark` | `pages/control/Benchmark` | 12 |
| Database | `/database` | `pages/control/Database` | 13 |
| Mcp | `/mcp` | `pages/control/McpServer` | 13 |
| Usage | `/usage` | `pages/control/UsagePro` | 13 |
| S3Backup | `/s3` | `pages/control/S3BackupPro` | 13 |
| Settings | `/settings` | `pages/Settings` | 13 |

Navigation groups, order and routes are identical to `components/layout/navConfig.ts`. Only labels change. The event-gateway plan (2026-10-21) later cut the 28 boards' items to 14 in four groups under Home (Work, Automation, Monitor, System; the Webhooks item became Event gateway, and Overview became Home, the one screen for every metric and error); `packages/panel/README.md` has the current shape.

## Design tokens that matter

- Palette (dark): paper `#0E171F`, surface `#16232E`, raised `#1F303D`, ink `#E7EDF3`, ink-soft `#A9B9C6`, ink-faint
  `#8497A8`, field line `#7D8E9E`. Light: paper and surface white, ink `#16232E`.
- Accents: coral `#FF865C` (selection, highlights, links), forest `#1F4438`, sun, aqua, rose, leaf.
- Roles: action `#E0F3E6` on `#1F4438` in dark, `#1F4438` on white in light. Danger `#FF8A80` dark, `#B42318` light.
- Status: ok `#74D68F`, warn `#FFC83D`, bad `#FF8A80`, active `#4FC3B3`, idle `#8497A8` (light: darker shades).
- Shape: pill buttons, field radius 14, tile 28, card 36. Targets 44 minimum, 52 for standard button and input.
- Focus: 3px outline, 3px offset.
- Type: Plus Jakarta Sans (words), JetBrains Mono (ids, code, logs).
- Colour is never the only status signal: every status has a glyph (ring, half ring or mark) and a word.

## Deviations, and what each one rests on

| # | Design element | Decision | Why |
|---|----------------|----------|-----|
| R1 | Stylesheet of classes | Ported as primitives and token values | The panel is Tailwind plus components. Copying the stylesheet would fork every page's markup. |
| R2 | New logo asset (`/_blob/2513…`) | Same Q mark, shown in a rounded app-icon tile (gradient `#FF7A00` to `#FF3D61`, dark glyph). `QelayMark` is unchanged. The lockup gains a tile and the words "Qelay" and "Cloud console". | The asset's paths are identical to `QelayMark`'s, so no new mark exists and `brand-assets.test` still holds. |
| R3 | Google Fonts link | Self-hosted through `@fontsource-variable/plus-jakarta-sans` and `@fontsource-variable/jetbrains-mono` (approved by the owner on 2026-10-20), latin and latin-ext subsets, upright only; `@fontsource-variable/inter` is removed. | CSP `font-src 'self'`. The subset and the system fallbacks match what the panel did for Inter. Task 01. |
| R4 | Namespace button ("production") | The existing "Active node" profile select, restyled to the `.org` look. Crumbs start at the active profile's name. | The panel has connection profiles and no namespaces. The select and its tests stay. |
| R5 | User block ("Chris Beckett, Operator") | Role from capabilities (`viewer` or `operator`) and, when sign-in is managed, a short form of the token subject. Sign-out moves into this block. Unmanaged sessions show the role only. | Display of data the stores already hold. No auth or role logic changes. |
| R6 | Health card ("Postgres and Pub/Sub are reachable. Last tick 4 s ago") | Control API state and the node host, from the existing 15 s `/health` poll. No claim about Postgres, Pub/Sub or the tick. | The panel has no source for them in the shell, and the repo's rule is to say only what is known. Re-check `/ready` in task 06 and use it only if it already carries those facts. |
| R7 | Nav counts (Queues 8, DLQ 128, Alerts 3) | None. The shell holds no queue or DLQ count, and the alert store holds rules, not triggered alerts, so no count or bell badge is shown. A collapsed group shows its item count, as before. | They would add polling to every page, or invent a number. |
| R8 | Top bar search with `/` key hint | The palette trigger is styled as the search field and keeps `Ctrl or Cmd K`. | A new shortcut is a behaviour change nobody asked for. |
| R9 | Theme toggle in the top bar | Moved there from the sidebar footer. Same store, same label rule (names the mode you switch to). | Matches the board. `nav-shell` and `brand-copy-guard` tests move with it. |
| R10 | Sentence-case nav labels | Adopted: Dead letter queue, Cron jobs, Job flows, Add job, Bulk add, Job inspector, Queue control, DLQ control, S3 backup. | Single source is `navConfig.ts`. The tests and e2e that name them change in task 06. |
| R11 | Page-body copy (new headings, ledes) | Adopted per page task where the board's text is true of the panel. Anything the panel cannot back up is not copied. | A page task edits the tests it breaks in the same task. |
| R12 | `*-classic` pages | Re-skinned by tokens and primitives only. | No board. |
| R13 | Demo mode banner and install prompt | Kept, restyled. | Not in the design, still a product feature. |
| R14 | Design's seeded sample data | Never used. Pages keep their live data and their stub fixtures. | The boards are mock-ups. |
| R15 | Pill text and glyph colour | Pill word keeps the state's text-grade colour (not ink) and the glyph uses it too; the glyph is added beside the word. | Text-grade shades are contrast-tested at 4.5:1; the design's light glyph shades are 3:1. Task 04. |
| R16 | Retry button labels | `Retry` stays on `ErrorState` and `OfflineBanner`, not `Try again` / `Reconnect now`. | Tests and e2e find the button by that name; the wording carries no behaviour. Task 05. |
| R17 | Crumbs (profile › page) | The group crumb is kept (profile › group › page) where the route has a group, because the trail was already three levels and its tests pin that. Below `sm` only the page shows. | Behaviour that exists; the board's two-level trail is a subset. Task 06. |
| R18 | Active row's left bar, top-bar "Live" indicator, Settings icon in the top bar | Not built. The active row is the coral wash, heavier weight and a `--hl` icon, with no bar. No live indicator (it would need a second poll or a shared store); the health card already shows the state. The Settings link is in the nav. | The wash is the board's own cue; the others add behaviour or duplicate a control. Task 06. |
| R19 | Root nav group's label | "Console", from `qnav.js`. `NAV` keeps `section: null` for it. | The board labels it; the code treats it as the unlabelled root so `locateNav` and `useNavGroups` are unchanged. Task 06. |
| R20 | Palette's Jobs group | Not built. The palette lists Pages and Actions only. | The board's job rows have no data source in the shell; listing jobs would add a request on every open. Task 07. |
| R21 | Table rows as `role=table` grid rows; log viewer's raw hex | Real `<table>` elements with the same row states; the viewer's colours are `--log-*` tokens, fixed in both themes. | Header association for screen readers is kept; the state-colours guard bans hex in components. Task 08. |
| R22 | Dark `--text-faint` `#8497A8`, light `--line-strong` `#7D8E9E` | Dark `#899cad` and light `#778898`. | The board's values fail the contrast the guard now checks in full: faint text is 4.31:1 on a selected row (needs 4.5:1), and the light field line is 2.86:1 on the grey page ground (needs 3:1). Task 16 review, with `design-tokens.test.ts` restored to check every surface and the selected wash. `--idle` keeps the board's `#8497a8`: it is a glyph, not text. |
| R23 | Where the palette lives | `src/tokens.css` holds both theme blocks and `src/index.css` imports it, then maps the roles into Tailwind. Values and order are unchanged. | `index.css` passed 300 lines (the cap in CLAUDE.md). The CSS-reading guards read both files. `.oxfmtrc.json` ignores `tokens.css` as it does `index.css`. Task 16. |
| R24 | Behaviour found by the task 16 review | `Field` now labels a `Textarea` child and merges a control's own `aria-describedby` with the hint and error. `TableScroll` is a tab stop (`tabIndex=0`, with a `shortcut:` note). The row custom property is `--row-bg` (was `--bg`, which shadowed the page token inside a row). Logs search is a literal, case-insensitive match (`markHits`). | Each was a defect in the re-skin (an axe `label` and `scrollable-region-focusable` failure on Cron and Transport, a shadowed token, an index drift on a length-changing letter), found by the review and fixed with a test first. |
| R25 | Type scale, title weight, control height | Text is one step larger than the boards: `--text-xs` 13px and `--text-sm` 15px (Tailwind's 12px and 14px), arbitrary sizes +1px, `.eyebrow` stays 12px. Extra-bold titles are bold. Buttons, fields and rows are 40px tall (the boards say 44px); the small icon button is 32px. | The owner found the console "compact, and large" and hard to read (2026-10-20) and chose bigger, calmer text. The boards' type reads small inside their large chrome. The e2e axe run still passes at the new sizes. |
| R26 | Form layout (the boards show single fields, not a form of five) | A label sits 8px above a 40px control. `FormRow` is `items-start` so a row's controls share one top edge; `FieldAction` (`mt-7 min-h-10`) drops a button to the control's baseline. A hint goes under the control, never beside it. | The owner (2026-10-20) found inputs "miss aligned" on the queue pages. The cause was labels of different heights and buttons centred against a label-plus-hint column. Tasks U1 and U2 of `ux-clarity`. |
| R27 | Plain wording in cards and fields | A card says what it is in one line and shows the current value. Jargon is replaced in the label (Rate limit becomes Speed limit, Concurrency becomes Jobs at the same time, Attempts becomes Tries, Stall becomes Stuck). Units live in the hint ("60000 is one minute"), and the payload keys do not change. | "Anyone can understand it" was the brief. The original term stays in the description where a reader might search for it. A rename of a key would break old clients, so only the visible text moved. |
| R28 | Where the rarely used controls go | `Disclosure` (native `<details>`) holds Advanced options, More options, Remove a limit and Why? notes. Everything that changes a live queue stays behind a confirm dialog, and "Type the queue name" interlocks stay as they were. | One main action per card. A page opened with every field showing was the owner's complaint; a closed `<details>` keeps the form and the e2e flow, and adds no state. |
| R29 | Unavailable actions | Said once per page, in plain words, with a "Why?" disclosure that carries the exact server message (`FLOW_*_UNAVAILABLE`). Per-card disabled explanations are dropped. A button that cannot work is not drawn next to an explanation of why it cannot. | Five lines of the same warning on one page read as five problems. The reason text is unchanged and still pinned by tests. |
| R30 | Settings the server does not accept | Shown as facts, not as inputs. The DLQ settings and the stall settings other than `maxStalls` are read-only `Facts`; the rate limit and the concurrency cap are Apply and Remove only. The `durable` toggle on Add job is removed (Postgres ignores it). | An input that does nothing is the worst kind of confusing. Read-only values are the honest picture of what the server lets you change. Sign-off: the removed toggle. |
| R31 | Monitoring apart from settings | A queue page has Overview (numbers and the job list) and Settings (cards that change something). Danger actions sit last in their card, below a rule. | Rubric 6 and 8 of `ux-clarity`. |
| R32 | Page titles and labels | Sentence case, matching the nav (R10): Dead letter queue, Cron jobs, Job flows, Add job, Job inspector, DLQ control, S3 backup, Create alert rule. Descriptions carry the plain-language gloss. | A page titled `Job Flows` under a nav item `Job flows` looked like two places. Tests and e2e that pinned the title case changed in the same task. |
| R33 | Control height against the boards | 40px for buttons, fields and rows, where the boards say 48px for fields and 44px for buttons (R25 already moved buttons to 40px). | Eight stacked controls at 48px run long on a laptop screen. Touch targets stay at or above 40px, and the sidebar rows keep their own size. Sign-off. |
| R34 | Read-first cards (a pattern from Hookdeck's settings and n8n's panels, not in the boards) | A settings card says what is set as one sentence with the numbers in bold, and has one **Edit** button that opens the fields (`ReadFirstCard`). Cancel or a good save closes it. The queue Settings cards use it. Cron and Webhooks put their create form behind **New schedule** and **New webhook** (`CreateCard`); on an empty list the form is open at once and has no button. | Fields that are not in the page cannot be misaligned or mistaken for facts. Sign-off: the in-form "created" line is gone (a toast and the new row say it), and the rate limit and concurrency cards cannot show the server's value because the API has no `GET` for them. |
| R35 | Job flows as a graph | The open jobs of a flow are boxes joined by lines, parent on the left (`FlowGraph`). It is for reading: no drag, zoom or pan. A Graph or List switch sits above it; Graph is the default on wide screens, phones start on List, and over 300 open jobs the list is shown with a note. The state glyph, state word, id and queue are inside the box, not below it. The list stays the view with arrow keys. | n8n's canvas turns a stuck chain into a picture. Labels inside the box keep a box readable at one size, and colour is never the only signal. Sign-off: the default view changed. |
| R36 | Workflow definition as a chain | The Definition tab is a left-to-right chain of nodes with the run's place marked (`DefinitionGraph`). Done and Not reached are drawn only while the run goes forward, and every node is Done when it completed. A dashed line runs from the current node back to the first while the run rolls back (danger colour when stuck). A node opens its detail and, when its step name is unique in the definition and in the record, the step's result. A failed run is not marked. | The server gives a failed run's cursor as a count, not a place, and a recorded step has no node index, so the panel marks and matches only what it knows. Stacks top to bottom on phones. |
| R37 | Teaching empty states | Cron, Webhooks, Job flows and the Dead letter queue show a 128 by 80 line drawing in the text colour (`illustrations.tsx`, through `EmptyState picture`) with a title that says what the feature is. The drawing is `aria-hidden`; the title carries the meaning. | An empty page is the first thing a new operator sees. Only these four pages; the rest keep the icon badge. |

## Not in the design, still in the panel

Copilot confirm card, Database SQL runner states, MCP tool list, benchmark run controls, S3 backup operations panel,
workflow compensation views. They take the primitives and the board of the nearest page, and any visual call that is
mine is noted in that task's Result.
