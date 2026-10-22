# Console redesign: the Carebell look for `packages/panel`

Date: 2026-10-20 · Plan: `.claude/.planning/console-redesign/CURRENT.md` (tasks 00 to 16; per-task notes are in
`2026-10-20-console-redesign-02…15-*.md`). Nothing is committed, pushed or published.

## Changed
- **Tokens and primitives:** `packages/panel/src/tokens.css` (both theme palettes, split out of `index.css`) and
  `src/index.css` (Tailwind mapping, base, utilities). `src/components/ui/**`: buttons, form controls, cards, page header,
  status glyph and pill, banners, toasts, empty, loading and error states, `Table.tsx` recipe, log viewer.
- **Shell and overlays:** sidebar, top bar, breadcrumbs, command palette, Copilot panel, drawers.
- **Pages:** the 30 board pages plus Auth and Page states. The `*-classic` pages take only tokens and primitives.
- **Tests and guards:** updated where they encoded the old look or copy, never loosened. New `design-rules-guard`.
- **Docs:** `docs/PORTING.md` row, `packages/panel/README.md` "Look and feel", `.oxfmtrc.json` ignores `tokens.css`.
- **Unchanged by design:** routes, the Control API client, `shared/`, capability gating, `src/lib/auth/**`, `authStore`.

## Review (code-review skill on the diff), what was fixed
- `Field` did not label a `Textarea` child (axe `label` on Cron): fixed, test first. It also now merges a control's own
  `aria-describedby` with the hint and error.
- `TableScroll` was not keyboard-focusable (axe `scrollable-region-focusable` on Transport): now `tabIndex=0`, with a
  `shortcut:` note.
- The row custom property `--bg` shadowed the page token: renamed `--row-bg`.
- Task 02 had narrowed two contrast checks: the tokens were corrected (dark `--text-faint` `#899cad`, light
  `--line-strong` `#778898`; both differ from the board, DESIGN-MAP R22) and the full checks restored.
- `markHits` (Logs search) took indexes from the lower-cased text, so a length-changing letter such as `İ` drifted, and a
  mixed-case term never matched: now a literal case-insensitive RegExp, failing test first.
- `SelectedEvent` (the Logs row link and copy moved there) had no test: added (href, copy control, close, no-job case).
- `index.css` passed 300 lines: palette moved to `tokens.css` (R23); the three CSS-reading guards read both files.
- Accepted, not changed: raw `rounded-[18px/20px/24px/12px/8px]` values are not tokenised (finding 13).

## Behaviour changes to know about
- Logs: no pagination; the row link and copy control moved into the selected-event card.
- Sign out moved from the top bar to the sidebar user block (mobile: in the drawer; also on Settings → Session).
- Flow `waiting-children` shows the generic waiting role and its word.
- The 404 has an h1; "Reload" is "Retry"; a failed route chunk reads "This page could not be opened"; the token gate has a
  visible label. `Banner` `problem` is now `role=alert` (several pages moved from a status banner).
- `TableScroll` is always a tab stop.
- The R14 not-built list (DESIGN-MAP.md) is what the boards show and the panel cannot back up.

## Checked (what ran, against what)
- Full gate (scratch Postgres 18.6, `QCLOUD_REQUIRE_DB=1`): typecheck, lint, `format:check`, `architecture` clean;
  `bun test` 5170 pass / 252 skip / 2 fail. `bun test packages/panel` from the root: 1524 pass, 0 fail.
- The 2 failures are outside the panel: the LICENSE/release test (also fails at HEAD) and a workflow-engine model seed
  (fast-check 1382233728) that did not reproduce on 3 quiet re-runs. Details in `16-verify.md`.
- Panel build passes. Playwright e2e with axe, Chromium only: 35 passed. `docs:check` passed. Route sweep: 172 renders,
  0 problems.
- **Re-run after task 01 (fonts), same setup:** gate typecheck, lint, format, architecture clean; `bun test` 5174 pass /
  252 skip / 1 fail (the LICENSE test only; the workflow-model seed did not recur). e2e 35 passed. Route sweep 172 renders,
  0 problems, plus a select-clipping sweep (three selects widened). Details in `2026-10-20-console-redesign-01-fonts.md`.

## Owed or not run
- **Task 01 (fonts) is done** (owner's approval 2026-10-20): Plus Jakarta Sans and JetBrains Mono replace Inter, see
  `2026-10-20-console-redesign-01-fonts.md` for what ran.
- **LICENSE:** `test/docs/release.test.ts` fails at HEAD too. Per-package LICENSE files still carry the "Copyright (c) 2024
  Egeo Minotti" line that commit 4103cee removed from the root LICENSE. A licence decision for the owner; not touched.
- **PG 16:** the read-plans throughput test fails on the local PG 18.6 (a Sort plan); CI runs PG 16. Owed via Docker.
- Docker-backed and emulator runs (ElasticMQ, Pub/Sub emulator, PgBouncer, TLS Postgres, PG 16) are deferred by standing
  instruction. Firefox and WebKit e2e not run. `docs:check` "documented commands" step skipped (no database URL in that shell).
- No pixel diff against the boards (they cannot be rendered here): 172 route renders swept, two compared by eye.
