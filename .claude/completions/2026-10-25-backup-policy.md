# Backups are declared, not run (D18)

Requested by the owner on 2026-10-25: "If user is using GCP they aren't going to be using s3 for backups. We need a better way for
someone to select what backup mechanism, as they may use their own outside of the Qelay platform." The owner chose, from
the options offered, to **declare and report** (Qelay runs no backup) and to **store the answer in Postgres**.

## What changed

- **Design record:** `DESIGN.md` D18 (decision row, section 6 paragraph, the feature-map line for "S3 backup").
- **Migration 25 and the store:** `qcloud_backup_policy` (one row per namespace; CHECKs keep `tool` and `location` to `external`),
  `store.backups.get()` and `.set()`, `checkBackupPolicy` (also used by the Control API). Snapshot regenerated; a row in
  `schema.planned.deployment.ts` for the read (primary key).
- **Control API:** `GET /backup-policy` (`{ policy: null }` while undeclared) and `PUT /backup-policy` (operator only). The audit entry
  names the mechanism, never the tool or location text. Two deployment warnings, `backup_undeclared` and `backup_none`
  (severity `warning`).
- **OpenAPI and generated docs:** `docs/openapi.yaml` (paths, four schemas, the warning codes), `docs/security/routes.md` and
  `docs/reference/routes.md` regenerated (134 routes). `docs/operations.md` Data section.
- **Panel:** a Backups page (`pages/control/Backups.tsx`, `backups/model.ts`) as the fifth Health tab; `/s3` redirects to it; the
  S3 gate and the System tab for it are gone; demo data and the fetch shim know `/backup-policy`.

## What ran, and against what

All on the local PostgreSQL at `127.0.0.1:55442` with `QCLOUD_REQUIRE_DB=1`. No Docker, no real cloud resource, no `terraform`.

- Store: `backupPolicy.test.ts`, `schema.migrate.backupPolicy.test.ts`, `schema.indexes.test.ts`, `schema.snapshot.test.ts`: pass.
- Control API: `backupPolicy`, `ops.deployment.backup`, `ops.warnings`, `openapi.ops`, `security.routes`: 51 pass.
- Panel: `backups-page`, `backups-model`, plus the updated tab, route and capability tests: pass.
- `typecheck`, `format:check`, `architecture`: exit 0. `lint`: exit 0 (warnings only, none in the new files).

## Left as it is

- **The old S3 backup code is unrouted, not deleted:** `pages/control/S3BackupPro.tsx`, `features/backups`, `s3Store`,
  `lib/demo/backups.ts` and about 15 tests that exercise them. Deleting it is a separate change.
- **Terraform retention is not wired in.** The Cloud SQL and RDS settings in `infra/` are not read into the declaration, so a
  deployment still has to be declared by hand.
- **Migration 25 sits on top of migration 24**, which is not committed either.
- The server still lists `s3Backup` among its hidden features; nothing reads it now.
- `docs/PORTING.md` is missing from the working tree (deleted before this task), so `docs:check` reports it. Not touched.
- Not looked at in a browser: light theme, phone width. The Backups page has not had an axe or keyboard pass.
- A warning does not turn the health strip amber: only a late doorbell does. Home and Deployment list every warning.
