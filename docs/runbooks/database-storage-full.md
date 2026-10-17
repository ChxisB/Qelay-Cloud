# Runbook: the database is running out of storage

**Alert.** `<name>-database-free-storage` on AWS: less than 10% of the allocated storage is free for ten minutes. GCP has no
policy for this: Cloud SQL grows its disk by itself (`disk_autoresize`), so watch the disk on the Cloud SQL page instead.

**What is safe.** Postgres is the only state. A database that runs out of space stops accepting writes: workers cannot claim
or settle, `add` fails, and the tick cannot record. Nothing already stored is lost, but do not delete rows blind to make room.
Growing the volume is safe and takes no downtime on RDS (it can only be done once every six hours).

## Check

1. Is autoscaling on and has it room? `database_max_storage_gb` in the data plane is the ceiling (equal to `database_storage_gb` turns it off). Compare it
   with `AllocatedStorage` on the instance: at the ceiling, RDS stops growing and the alarm stays on.
2. What is big:

   ```sql
   SELECT relname, pg_size_pretty(pg_total_relation_size(oid)) AS total
   FROM pg_class WHERE relkind = 'r' AND relname LIKE 'qcloud\_%' ORDER BY pg_total_relation_size(oid) DESC LIMIT 10;
   ```

   Jobs and events dominate in a healthy system. A table that keeps growing while the work is steady means the tick is not
   cleaning it ([the tick](tick-stopped.md)): retention, the event journal and webhook delivery rows are pruned by the tick.
3. Dead space, not live data: `SELECT relname, n_dead_tup FROM pg_stat_user_tables WHERE relname LIKE 'qcloud\_%' ORDER BY n_dead_tup DESC;`.
   Autovacuum frees space for reuse inside the table; it does not give it back to the volume.
4. Who is still writing: finished jobs kept for good (`removeOnComplete` unset), a queue full of failed jobs
   ([failing for good](dead-letter-queue-growing.md)), or a webhook receiver that is down while deliveries pile up.

## Fix

- **Grow the volume first.** Raise `database_max_storage_gb` (and `database_storage_gb` when autoscaling is off) in the
  data plane and apply it (`terraform plan` shows a change in place, no replacement). Applying is a real-cloud write that needs
  the owner's go-ahead.
- **Then stop the growth.** Make the tick run again if it did not. Give new jobs `removeOnComplete: true` where the result is
  not needed. For finished jobs that are already there, one queue at a time:
  `POST /queues/{queue}/clean` with `confirm` set to the queue name, `state` `completed` and a `grace` you accept
  (a day is `86400000`); repeat the call while it answers `done: false`. It deletes finished jobs for good, so read the queue's
  counts first and start with a long grace.
- **Do not** `TRUNCATE`, `DELETE` by hand from `qcloud_*` tables, or `VACUUM FULL` on a full disk (it needs room for a copy).

## Verify

`FreeStorageSpace` rises above the threshold and the alarm closes; `GET /deployment` shows `database.state` ok; a test `add`
and its job complete.

## Escalate

The volume is at its limit and cleaning frees nothing: restore to a bigger instance ([restore](restore-from-backup.md)) rather
than delete. Open an issue with the table sizes from step 2.

Not run on a real cloud, and a full disk was never reached. The game day runs the table-size query and the `clean` rounds on a
small local database ([README](README.md#what-was-run)); the volume change is a Terraform plan only.
