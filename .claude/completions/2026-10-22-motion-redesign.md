# Motion redesign: a connected, moving console for `packages/panel`

Date: 2026-10-22 · Plan: `.claude/.planning/motion-redesign/CURRENT.md` (tasks 01 to 15; each task's Result is in its own
file beside it) · Design: https://claude.ai/artifact/TMMbZ97jDRzvSpWiFVKRuG (canvas "Design", version `1792625519-cabd`,
16 boards; sample content only, private until the owner shares it). Nothing is committed, pushed or published.

## Changed
All under `packages/panel`; the working tree also holds 500+ uncommitted paths from the review branch, so the per-task
Results are the exact list. By area:

- **Motion system (01, 02):** non-colour tokens in `src/tokens.css` (`--dur-enter` 300 ms, `--dur-exit` 180 ms, `--ease-exit`,
  `--dur-stagger` 40 ms capped at 8, `--dur-draw` 600 ms, `--dur-flow` 900 ms), `src/motion.css` (arrive, leave, stagger,
  change flash, line draw, one-shot pulse) and `src/lib`: `usePresence`, `useLeavers`, `useChangeFlash` / `useRises`,
  `useRevealFocus`, `pageTransition`. Every animation sits inside `prefers-reduced-motion: no-preference`. No new dependency.
- **Connected language (03):** `components/ui/nodegraph/` (node, line, pill on the line, rule glyphs, hover card).
- **Shell and overlays (04a, 04b):** sidebar highlight, connection badge, route transition, phone menu; command palette,
  Copilot, Toaster, drawers, and the in-page `ConfirmDialog` that replaces `window.confirm` (27 call sites, none left;
  `native-dialog-guard.test.ts` keeps it so).
- **Feedback and data display (05):** Banner, CopyButton, StatCard, Meter, AreaChart, Table, Toggle, StatusBadge.
- **Event gateway (06 to 08b):** Connections as the line diagram (source, connection, destination, 24-hour figure, saved
  views), the connection page and Create, Events, event detail, Issues, Destinations, Metrics.
- **Home (09a, 09b), Queues (10a), Jobs and inspector (10b), DLQ, Bulk add, Add job (10c), Cron (11a), Flows and workflow
  runs (11b), Metrics and Logs (12a), Workers and Alerts (12b), Health pages (13a), System (13b), Benchmark, Fleet and
  Settings (13c), Sign in and page states (13d).**
- **Guards and docs (14):** `test/motion-guard.test.ts` (no raw duration or `@keyframes` outside the token layer),
  `test/native-dialog-guard.test.ts`, `packages/panel/README.md` "Look and feel", one row in `docs/PORTING.md`.
- **Unchanged by design:** routes, the Control API client, `shared/`, `flowOperationPolicy.ts` gating (no control drawn for a
  gated action), auth and roles, migrations, `infra/`, `docs/openapi.yaml`.

## Fixed in task 15 (verify and review)
- `code-review` on the diff found 6 real defects, each fixed test first: `startPageTransition` `latest` guard,
  `useChangeFlash` `Object.is`, `useRevealFocus` `acted` ref, `useLeavers` `timed` ref and deps, `inert` while `ConfirmDialog`
  and `CommandPalette` leave, a queued opener in `confirmStore`. One finding was not a bug (StatusConsole halo); one is
  theoretical and skipped (`NodeTile` `style` spread).
- Accessibility defects this plan caused: axe `definition-list` on `/deployment` (`Facts.tsx`), and a heading level skipped
  on the Connections diagram (`ConnectionDiagram.tsx` is now `aria-level={2}`). Both test first.
- Layout seen by eye: `Select` `w-auto!` (2 sites), the `SavedViews` `Input` `w-40!` (it rendered about 385 px and wrapped
  "Save view"), cron arrow `gap-6`. Cause: `cn` is a plain joiner, so a width class loses to the primitive's `w-full`.
- e2e: `expectAccessible` waits for finite animations before axe (it read mid-fade colours); `openFromJobs` takes the
  heading; `all-routes` lists `['/overview-classic', '']`.

## Checked (what ran, against what)
Scratch Postgres 18 on the host, so every database-backed result is an "emulator" result in the sense of `docs/limits.md`.

- Gate, from the repo root: `typecheck`, `lint` (exit 0, 109 react-compiler advisory warnings, none in the motion hooks or
  overlays), `format:check`, `architecture` pass.
- `bun test packages/panel`: **2100 pass, 0 fail, 293 files** after the last edit.
- Full `bun test` before the last panel-only edits: 5929 pass, 252 skip, **2 fail, both outside this plan** (below).
- `bun run docs:check` passed (one skip: documented commands not run, Postgres had been stopped).
- Panel build passed. `bun run test:e2e`, Chromium headless shell only: **34 pass, 1 fail**, the stale `e2e/webhooks.e2e.ts`.
- `web-design-guidelines` on 9 UI files: no actionable finding (it asks for `overscroll-behavior: contain` on the scrim, not
  needed because the scrim blocks scroll; and Title Case headings, which the panel's sentence-case rule forbids).
- Accessibility, `dev:stub`, Chromium: settled axe over 26 routes in both themes at 1280×720; keyboard walk (19 stops);
  confirm dialog (focus start, trap, `inert` behind, Escape, focus return, reduced motion); command palette (focus,
  `aria-activedescendant`, `inert` behind, Escape, focus return); reflow at 320×256 on four routes. Details and the
  `audit_live` mid-fade caveat are in `15-verify-review.md`.
- By eye, stills only, no board beside the page: Home (1280 and 390), Connections diagram (dark, light, 390), Queues, Jobs,
  Cron, Flows, Job delivery, Deployment, Events, Settings.

## Owed or not run
**Fails that are not this plan's, left as they are**
- `test/docs/release.test.ts`: package LICENSE files still carry "Copyright (c) 2024 Egeo Minotti" (a licence decision).
- `packages/store-postgres/test/schema.indexes.test.ts`: the workflow-counts plan uses the pkey, not
  `qcloud_workflow_executions_name_state_idx` (store code, outside a panel task).
- `e2e/webhooks.e2e.ts` targets the removed Webhooks page (`:66` has a dead `page.once('dialog', …)`); delete or rewrite.

**Accessibility, same at HEAD, not fixed here**
- Home "Live" pill in the light theme, 3.93:1 (`OverviewHeader.tsx:46`, `state-completed` pair over `--bg`): token change.
- `Topbar.tsx:96` `aria-label` "Open command palette" does not contain the visible "Search or jump to…" (WCAG 2.5.3).
- Command-palette Results listbox is a Tab stop in Chromium (`CommandPaletteList.tsx:38`; `tabIndex={-1}` would fix it).
- `Table.tsx:29` `TableScroll` `tabIndex={0}` is the documented deliberate stop.
- ◐ The skip link is 94×19 px while focused (2.5.8); the spacing exception probably applies, confirm by eye.
- ○ No screen reader was run (dialog, palette, toasts, live regions). The Copilot panel, drawers and hover card were
  unit-tested only, not driven in a browser; 2.4.11 was not checked.

**Not seen in motion, only reasoned and unit-tested:** animation replay on a poll, QueueLifecycle and DeliveryLine grids,
tab underline slide, timeline, CronWire grid, `motion-leave` plus `inert` on a `<tr>`, flow-graph wash under `truncate`,
chain redraw, log-line slide, chart step slide, the 10 px halo dot, Run dimmed under `aria-disabled`, progress `scaleX`,
Clean result row, Fleet stagger, token lock pop and leave, the sign-in card's keyed fade. The view transition cannot run
in happy-dom. There is no visual diff harness and no board was compared beside the page.

**Not run:** Firefox and WebKit e2e; SQS (ElasticMQ), Pub/Sub emulator, PgBouncer and TLS suites, `test:model`,
`check:terraform` (none touched by a panel-only change); Docker; any real cloud (no go-ahead, none needed).

## Needs the owner's word before release
- Wording added by the design: Home H1, W1, W2, A2, M3, M6, SY1, SX1, G7, Health H2, SS1 (listed in `DESIGN-MAP.md`).
  Home H1, W1, W2, A2, M3, M6, SY1, SX1 and G7 were approved with "yes" on 2026-10-22; Health H2 and SS1 were not.
- Deviations: SX6 (a block in place of the clamp), SS1 (fade-in, not a crossfade), SS8 (offline strip has no leave).
- A2, 12b and 13a to 13d as a whole (`DESIGN-MAP.md` lists them as owed to the owner's word).
- The Home "Live" pill token pair, the Topbar label, the palette Tab stop, and the skip-link size (above).

## Design and docs
- Claude Design link and date are in `packages/panel/README.md` "Look and feel" and in `CURRENT.md`.
- `docs/PORTING.md` has one row under "Panel" for the divergence from the upstream panel (D8).
- Memory note saved: `panel-cn-does-not-merge-classes` (a width class on `Input` or `Select` needs the `!` suffix).
