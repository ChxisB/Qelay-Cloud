# Console redesign 13: Settings, Usage, S3 backup, Database, MCP

Date: 2026-10-20 · Plan: `.claude/.planning/console-redesign/13-pages-management.md`

## Changed (all under `packages/panel/`)
- `src/pages/settings/*` (`ConnectionProfilesCard`, `SessionCard`, `AppearanceCard`): `Field` wiring, banners, 44px secret toggle.
- `src/pages/control/UsagePro.tsx`: storage `Banner`s.
- `src/pages/control/S3BackupPro.tsx`, `s3Backup/S3EnvironmentCard.tsx`, `src/features/backups/ui/BackupOperationsPanel.tsx`: summary pill, info banner, labelled selects, named `CodeBlock` with the redaction kept, table recipe.
- `src/pages/control/database/*` (`DatabaseShell`, `FilterBar`, `QueryRunner`, `ResultsTable`, `SchemaView`, `RowDetailDrawer`): table list buttons, recipe results table, `Tag` constraints, shared `Textarea`, problem `Banner`, `CodeBlock` values.
- `src/pages/control/McpServer.tsx`: named `CodeBlock` snippets with `CopyButton`, titled warn banners, `Tag` chips.
- New `test/page-forms-13.test.tsx`; `test/frontend-a11y-fixes-03.test.ts` selector updated to `[role="alert"]`.

## Checked
- `bun test packages/panel` (repo root): 1504 pass, 0 fail.
- `typecheck`, `lint` (exit 0), `format:check`, file size, `architecture`: clean.
- `git diff --stat -- packages/panel/shared`: empty.
- Panel build ok; `?demo` screenshots of five routes in both themes at 1440 and 390: no horizontal scroll, no page errors.

## Owed or not run
- Playwright e2e and axe (local Postgres on 55442 was down): Phase 4.
- No screenshot diff against the boards.
- Not built, no data source: see the task Result (Usage KPIs, range and charts; S3 KPIs and storage card; Settings Copilot card; Database KPI row and layout; MCP mode radio and tool search).
- Behaviour notes: the Settings degraded-health result and the Database, Query, S3 and Backup errors are now `alert`; "Clear" in query history is "Clear history"; the selected-table name and "Tables (n)" are `h2`.
