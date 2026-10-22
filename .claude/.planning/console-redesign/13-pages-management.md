# 13 — Pages: Database, MCP, Usage, S3 backup, Settings

**Status:** done · **Depends on:** 06 · **Touches:** packages/panel/src/pages/control (Database, Mcp, Usage, S3Backup, Settings and their parts), packages/panel/test, packages/panel/e2e

## Goal
The management pages use the new primitives and match their boards, and the panel-only pages (Database SQL runner, MCP
tool list, S3 backup operations) are restyled with the same vocabulary.

## Steps
1. Read each board in full and the sources. For a page with no board (Database, MCP, S3 backup operations) compose it from
   the Components board.
2. Settings: sections as cards, the theme control, profile management, the token field as `.mask` styling only.
3. Usage: key figures and the usage chart.
4. Database, MCP, S3 backup: tables, code blocks, confirmations.
5. Update tests and e2e that assert old markup.

## Acceptance
- Same data, requests and gating as before (existing tests pass, with string updates only).
- Settings still stores nothing new, and a token or connection string is never printed.
- The Database SQL runner keeps its read-only guard and its confirmation.

## Verify
```bash
bun test packages/panel && bun run typecheck && bun run lint && bun run format:check
```

## Risks / notes
- Pages without a board are the likeliest place for a visual mismatch. Say in the Result which ones were composed, not copied.

## Result

Settings, Usage, S3 backup, Database and MCP are on the new form, banner, table, tag, code-block and pill primitives. Same fields, requests, redaction, read-only guard, confirmation and capability gating. Settings stores nothing new, and no token or connection string is printed.

**Composed, not copied** (no board): Database (shell, filter bar, results, schema, row drawer, SQL runner), MCP, and the S3 backup operations panel (`BackupOperationsPanel`). They were built from the Components board vocabulary. Settings, Usage and the S3 setup page have boards, but only the parts with a data source were taken (see Not built).

**Changed**
- Settings: `ConnectionProfilesCard` on `Field` (the bad server and agent URLs are tied to their inputs by `aria-invalid` and `aria-describedby`), a titled warn or ok `Banner` for the save notice, an ok `Banner` or a problem `Banner` ("The test did not pass") for the test result, and secret fields with a 44px show/hide `IconButton`. `SessionCard` and `AppearanceCard` are on `Card`/`CardHeader`.
- Usage: the storage message is a `Banner` (a full disk is a titled `alert`, a healthy one a polite `status`). The e2e hooks 'Disk writes are being accepted.' and 'Jobs pushed (since restart)' are kept.
- S3 backup: a summary band with a `StatusPill` ("Configure" or "Ready"), an info `Banner` ("Configured on the server"), `Field`-wrapped selects, and the storage check result as a `Banner`. `S3EnvironmentCard` shows the server environment in a named `CodeBlock` with a `CopyButton`, and the redaction chain (access key, secret key, session token) is unchanged. `BackupOperationsPanel` uses `Button`, `Banner` and the table recipe.
- Database: Tables list as `aria-pressed` buttons (44px, selected is a neutral tint), the selected table and "Tables (n)" are `h2` headings. The results table is on the recipe (sticky header, `aria-sort`, right-aligned numbers, 44px sort buttons, a named `View row N details` button per row, NULL shown as a word). The schema view uses `Tag`s for PK, NOT NULL and UNIQUE and a named DDL `CodeBlock`. The row drawer uses `CodeBlock` for multiline values and keeps its focus trap. The SQL runner uses the shared `Textarea`, `Button` chips for history ("Clear history" is the new label of the old "Clear") and a problem `Banner`. The read-only guard, the confirmation, request handling and `parseDbQueryResponse` are untouched.
- MCP: every snippet is a named `CodeBlock` with a `CopyButton` (Install commands, Embedded mode configuration, TCP mode configuration, Claude Code command). Both warnings are titled warn `Banner`s. Chips are `Tag`s.
- Tests: new `test/page-forms-13.test.tsx` (10 tests: S3 environment redaction and error list, S3 pill and info banner and labelled selects, results table sort state and alignment and NULL, row View button, read-only results, schema constraints and DDL region, MCP banners and regions, Settings URL error wiring and failed-test alert, Usage full-disk alert). `frontend-a11y-fixes-03` pinned `[role="status"].text-danger` for the degraded health result and now pins `[role="alert"]`; its content assertions are unchanged.

**Ran**
- `bun test packages/panel` from the repo root: 1504 pass / 0 fail.
- `bun run typecheck`, `bun run lint` (exit 0, the warnings left were at HEAD), `bun run format:check`, `bun scripts/check-file-size.ts` (1583 files), `bun run architecture`: clean.
- `git diff --stat -- packages/panel/shared`: empty.
- Panel build ok. `?demo` screenshots of `/settings`, `/usage`, `/s3`, `/database`, `/mcp`, both themes, 1440 and 390 wide, from `vite preview`: no horizontal scroll, no page errors. Database (light, 1440), MCP (dark, 1440) and S3 backup (light, 390) were looked at by eye. Preview stopped afterwards.

**Not run**
- Playwright e2e and axe: the local Postgres on 55442 was down at last check. Left for Phase 4. The e2e files reference these pages only by route or heading (`control-api.e2e.ts` checks storage after visiting `/settings`), so no locator edit was needed.
- No screenshot diff against the boards. Error and busy states the demo does not show are covered by unit tests only.

**Not built (R14, no data source or new behaviour)**
- Usage: KPI row, range selector and charts.
- S3 backup: KPIs, "Storage status" card, a "Back up now" action on the setup page (the operations panel has it).
- Settings: the Copilot card and the preview toggle.
- Database: the board's KPI row differences and its 7/5 layout.
- MCP: the embedded or TCP mode radio and the tool-category search (both configurations stay side by side).

**Changed behaviour to note**
- Banner roles: the Settings degraded-health result and the Database, Query, S3 and Backup errors are now `alert` (they were `status` or plain text).
- The history "Clear" button is now "Clear history". The Database selected-table name and "Tables (n)" are now `h2` headings.

**Kept**: all route and Control API behaviour, the S3 redaction, the Database read-only guard and confirmation, the focus trap in the row drawer, and the e2e hooks.
