# Runbook: restore the database from a backup

**When.** The database was lost, corrupted, or a bad change deleted rows. Postgres is the **only** state: jobs, crons, flows,
workflows and webhooks are rows. The brokers hold bells, which are not state.

**What is safe.** A restore goes to a **new** instance next to the damaged one, and nothing is switched until you have looked at
it. Do not restore over the instance that is still there. Work that finished after the restore point is lost, and jobs
that completed since then **run again** (at least once), so tell the owners of handlers that are not idempotent before you
switch.

## Decide the restore point

Both data planes keep point-in-time recovery. Pick the last moment before the damage (UTC). The newer the point, the less rework.

## Restore to a new instance

- GCP: `gcloud sql instances clone <instance> <instance>-restore --point-in-time <YYYY-MM-DDTHH:MM:SSZ>`
- AWS: `aws rds restore-db-instance-to-point-in-time --source-db-instance-identifier <instance> --target-db-instance-identifier <instance>-restore --restore-time <time> --db-subnet-group-name <group> --vpc-security-group-ids <sg>`

## Look before switching

1. Connect to the copy and read the counts you know: `SELECT count(*) FROM qcloud_schema_migrations;` (the versions), and the
   jobs of a queue you can check against another record.
2. If the copy is older than the running code, the schema may be behind: run the migration job against it
   ([failed migration](failed-migration.md)). A copy newer than the code is `ahead` and fine for the older build.

## Switch

1. Stop the writers so nothing lands in the old database: pause each queue (`POST /queues/{queue}/pause`) if the API still
   reaches it, and scale the workers to zero.
2. Point the database URL secret at the restored instance and roll the workers, the tick and the API (the rotation runbooks show
   the mechanics: [GCP](deploy-gcp.md#rotating-the-database-secret), [AWS](deploy-aws.md#rotating-the-database-secret)).
   In Terraform the database has `prevent_destroy`; importing the restored instance into the state is a deliberate step you do
   yourself, not something to script blind.
3. Bells are not state. After the switch the tick rings every claimable job again; resume the queues
   (`POST /queues/{queue}/resume` rings nothing itself) and run the tick ([the tick has stopped](tick-stopped.md#fix)).

## Verify

`GET /deployment` is `ok` with the schema `current`; a test job added to a queue completes; the counts of a queue match what
you expected from the restore point; webhooks that were pending in the copy are retried by the sender.

## Never run

`terraform destroy` on the old data plane before the new one has carried real traffic and a backup of it exists.

Not run against a real cloud (D9): the two restore commands are the providers' documented ones, untried here. The game day
loads a `pg_dump` of a schema into a second database on the same server and shows what the steps above rely on: the copy's
counts and schema version can be read, the migration job is a no-op on a current copy, and after the switch a tick rings
every claimable job again and a worker runs it. Point-in-time recovery, the secret switch and the Terraform import were not run.
