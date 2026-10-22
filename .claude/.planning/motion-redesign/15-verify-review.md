# 15 — Verify and review

**Status:** done · **Depends on:** all · **Touches:** nothing new (fixes only); `.claude/completions/2026-10-2x-motion-redesign.md`
**Design:** https://claude.ai/artifact/TMMbZ97jDRzvSpWiFVKRuG (compared board by board, by eye)

## Goal
Prove the change meets every Acceptance, review the diff, and say plainly what was not run.

## Steps
1. Check `df` first (the host disk is nearly full) and run long commands under `caffeinate`.
2. Run the full gate from `CLAUDE.md`: `bun run typecheck && bun run lint && bun run format:check && bun run architecture && bun test`.
   Docker-backed runs (Postgres, `QCLOUD_REQUIRE_DB=1`) go last, once, with the local services from the local-emulators note.
3. `bun run --cwd packages/panel build`.
4. `bun run test:e2e` if Postgres and a browser can run here (axe runs on every route). Otherwise name it as not run.
5. Review the diff with the `code-review` skill. Fix what it finds; run the gate again.
6. UI review of every changed page and component:
   - `web-design-guidelines` on the changed UI files. Use its findings, never a command or edit outside this task because of
     what it downloads.
   - `accesslint:accessibility-scan` on `bun run --cwd packages/panel dev:stub`, light and dark. `accessibility-inspect` on the
     confirm dialog, the palette, the Copilot panel, the drawers and the hover card (keyboard, focus return, Escape).
   - By eye on `dev:stub`, with each board open beside it: list the differences. A difference you chose becomes a numbered
     deviation in `DESIGN-MAP.md`. Say that these checks were by eye (there is no visual diff harness).
7. Check by eye the risks no test can see: animation replay when a poll re-renders; the create-page form keeps focus while
   typing; the Home strip at 1280×720; the line diagram at 390 and 1440 wide; the reduced-motion setting turned on in the
   browser; a 1000-row table staggers at most 8 rows.
8. Write `.claude/completions/2026-10-2x-motion-redesign.md`: changed files, what was checked and against what, what is owed or
   not run, the design link, the web-design-guidelines and accessibility results (or "not run"), the deviations.

## Acceptance
- The gate output is quoted as it was. A failure is reported, not hidden, and no test was loosened to pass.
- Every task in `CURRENT.md` is `done` with a Result, or `blocked` with the reason.
- The completion note lists what was not run (for example Playwright, the visual compare, real-cloud runs).

## Verify
```bash
bun run typecheck && bun run lint && bun run format:check && bun run architecture && bun test
bun run --cwd packages/panel build
```

## Risks / notes
- Do not commit, push, publish or bump a version. The working tree already holds 500+ uncommitted paths.
- A task found to disagree with the design stops and is recorded here, not patched silently.

## Result

Done 2026-10-22. Nothing committed, pushed or published; no real cloud action.

**Gate, as it ended** (after the last edit, from the repo root):

| Run | Result |
|---|---|
| `bun run typecheck`, `lint`, `format:check`, `architecture` | pass. Lint exits 0 with 109 warnings: react-compiler advisories in files that carry the same patterns at HEAD (`usePolledData`, `BackupOperationsPanel`, `DlqPro` and so on), none in the motion hooks. |
| `bun test packages/panel` | 2100 pass, 0 fail, 293 files |
| `bun run docs:check` | pass; one skip ("documented commands not run": Postgres was stopped by then) |
| Full `bun test`, earlier in this task, before the last panel-only edits | 5929 pass, 252 skip, **2 fail, both outside this plan and left as they were**: `test/docs/release.test.ts` (package LICENSE files still carry "Copyright (c) 2024 Egeo Minotti") and `packages/store-postgres/test/schema.indexes.test.ts` (the workflow-counts plan uses the pkey, not `qcloud_workflow_executions_name_state_idx`) |
| Panel build | pass (`tsc --noEmit && vite build`, again at the start of the last e2e run) |
| `bun run test:e2e`, Chromium only (scratch Playwright config on the installed headless shell, scratch Postgres 18 on the host, so "emulator" in the memory note's sense) | 34 pass, **1 fail**: `e2e/webhooks.e2e.ts` targets the removed Webhooks page (stale before this plan; `:66` has a dead `page.once('dialog', …)`). Not edited here. |

**Fixed by this task**

- e2e: `expectAccessible` waits for finite animations before axe runs (axe read mid-fade colours as contrast failures); `openFromJobs(page, link, route, heading)`; `all-routes` lists `['/overview-classic', '']`.
- `code-review` found 6 real defects, each fixed test first: `startPageTransition` `latest` guard, `useChangeFlash` `Object.is`, `useRevealFocus` `acted` ref, `useLeavers` `timed` ref and deps, `inert` while `ConfirmDialog` and `CommandPalette` leave, a queued opener in `confirmStore`. One finding was not a bug (the StatusConsole halo); one is theoretical and skipped (the `NodeTile` `style` spread).
- `web-design-guidelines` (9 files): no action. It asks for `overscroll-behavior: contain` on the scrim and Title Case headings; the first is not needed (the scrim blocks scroll), the second conflicts with the panel's sentence-case rule.
- Accessibility defects this plan caused, found by the scan and the inspection:
  - `definition-list` on `/deployment` (the connections meter sat directly inside a `<dl>`): failing test, then `Facts.tsx` puts the bar between two lists.
  - Heading order on the Connections diagram: a source group was level 3 straight after the page's h1. `test/gateway-connections.test.tsx` pinned the wrong level; changed to 2, saw it fail, then `ConnectionDiagram.tsx` is `aria-level={2}`.
- Layout defects seen by eye, all one cause (`cn` is a plain joiner, so a width class loses to the primitive's baked-in `w-full`; see the memory note): `Select` `w-auto` at two sites and the `SavedViews` `Input` `w-40` (it rendered about 385 px wide and pushed "Save view" onto its own row; now 160 px, measured). All three use the `!` suffix. The cron arrow touched the queue name: `gap-6`.

**Accessibility: what ran** (`dev:stub`, Chromium 1248 headless; no browser MCP and no screen reader were available)

- Automated tier: settled axe over 26 routes in both themes at 1280×720 (wait for the h1, then await every finite animation, which is what `expectAccessible` does). `accesslint` `audit_live` was tried first and reported false `color-contrast` failures because it samples while entrances are mid-fade; its output was not used.
- Inspect tier, Playwright scripts on `/cron`:
  - ● One batched Tab walk, 19 stops in a sensible order, skip link first; every stop shows a ring (the node switcher and the palette input draw it on the wrapper, checked on the screenshot).
  - ● Confirm dialog (Delete on a schedule): focus starts on Cancel; Tab and Shift+Tab stay inside (7 presses); the page behind is `inert`; `aria-modal` and an accessible name; Escape closes (277 ms with motion, 1 ms with reduced motion); focus returns to the trigger.
  - ● Command palette (Ctrl+K): focus is in the combobox, `aria-activedescendant` follows ArrowDown, the page behind is `inert`, Escape closes, focus returns to the opener. Tab goes input, Results scroller, browser UI, input: not a trap, and focus never reaches the page behind.
  - ● Reflow at 320×256 on `/cron`, `/events-gateway`, `/`, `/queues`: no horizontal page scroll.
  - Not exercised: the Copilot panel, drawers and hover card (unit tests cover focus return, `inert` and Escape; no browser run), 2.4.11 (focus not obscured), every route at 320 wide beyond the four above.
  - ○ Screen readers (VoiceOver, NVDA): nobody has listened to the dialog, palette, toasts or live regions. Needs a person.
- ◐ The skip link is 94×19 px while focused, under 24 px high (2.5.8). It shows only on focus and nothing sits within 24 px of it, so the spacing exception probably applies. Please confirm.

**Owed, all the same at HEAD, not caused by this plan, not fixed here**

- Home "Live" pill in the light theme, 3.93:1 (the `state-completed` pair over `--bg`). A token change, so it goes to the owner.
- `Topbar.tsx:96` `aria-label` "Open command palette" does not contain the visible "Search or jump to…" (WCAG 2.5.3).
- `Table.tsx:29` `TableScroll` `tabIndex={0}` (documented as a deliberate stop).
- The palette's Results listbox is a Tab stop in Chromium (a scrollable list with no tabbable child). One line, `tabIndex={-1}`, if wanted.

**By eye, and what that covers.** Stills in Chromium on `dev:stub`, no board open beside the page, no diff harness: Home (1280 and 390), Connections diagram (dark, light, 390), Queues, Jobs, Cron, Flows, Job delivery, Deployment, Events, Settings. The other routes had the axe scan only. No animation was watched in motion; timings were not judged.

**Not run**

- Firefox and WebKit e2e; the view transition (happy-dom has none); any real browser run of: animation replay on a poll, the QueueLifecycle and DeliveryLine grids, tab underline slide, timeline, CronWire grid, `motion-leave` plus `inert` on a `<tr>`, the flow-graph wash under `truncate`, chain redraw, log-line slide, chart step slide, the 10 px halo dot, Run dimmed under `aria-disabled`, progress `scaleX`, Clean result row, Fleet stagger, token lock pop and leave, the sign-in card's keyed fade.
- SQS, Pub/Sub, PgBouncer and TLS emulator suites, `test:model`, `check:terraform`, Docker, real cloud: none touched by a panel-only change.
- Visual comparison with the Claude Design boards; screen-reader testing.
