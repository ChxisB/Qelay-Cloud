# Runbook: a migration failed

**Signal.** The migrate job exits 1. Its log line has `msg`: `migration_failed` (a step failed), `schema_ahead` (the database is
newer than this build) or `schema_drift` (a shipped migration was edited: its recorded checksum differs). Exit 2 is a
configuration error (no database URL). Services started before a migration report `/health/ready` 503 with the schema
`behind`; that is waiting, not a failure.

**What is safe.** Each migration runs in one transaction under an advisory lock, so a failed step rolled back whole and a second
run starts from the same place. The old release keeps working against the old schema; a service that is `behind` becomes ready by
itself once the migration is done. Do not edit a shipped migration and do not delete rows of `qcloud_schema_migrations`.

## Check

- `GET /deployment`: `schema.state` (`current`, `behind`, `ahead`) with `current` and `expected` versions.
- The job's log: GCP `gcloud run jobs executions list --job <name>-migrate --region REGION` and the execution's log; AWS the
  log group `/qcloud/<name>/migrate` and the task's exit code ([running the migration](deploy-aws.md#running-the-migration)).

## Fix

- `migration_failed`: the error text names the statement. Common causes are a role without the privilege to create (the migration
  URL may name a more privileged role than the services), a lock timeout against a busy table, or a full disk. Fix that and run the
  job again; re-running is safe and a no-op once the database is current.
- `schema_ahead`: an **older** build ran `migrate`. Do not run it; serve the older revision against the newer schema
  (the rollback in [operations](../operations.md#rolling-back)) or deploy the build that matches.
- `schema_drift`: someone changed a shipped migration file. Restore the file from version control and ship the change as the next
  version. This stops every process until it is restored.
- If a defect is in the migration itself, fix forward with a new version. A migration may add a nullable column, a column
  with a default, a table or an index; it never drops, renames or retypes what the previous release still uses.

## Verify

The migrate job exits 0 and `GET /deployment` shows `schema.state` `current`; `/health/ready` is 200.
