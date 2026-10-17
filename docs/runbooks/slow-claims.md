# Runbook: claims are slow

**Alert.** The optional "<name>: slow claims" policy on GCP (the 99th percentile of `qcloud.worker.claim_ms`), which exists only
when you export that metric ([observability](../observability.md#what-is-not-wired-for-you)). Without it you see the symptom
elsewhere: jobs start late although workers are idle, the database CPU alarm (`<name>-database-cpu` on AWS) is firing, or
workers log claim failures (`qcloud.worker.claim_failed`).

**What is safe.** A claim is one short transaction that takes the next job and leases it. A slow claim delays jobs but never
loses or duplicates one. Do not restart the database; do not add workers (each one adds claims to a database that is already
slow).

## Check

1. Is it the database? Cloud SQL or RDS CPU, IOPS and free storage on the provider console; `GET /deployment` shows
   `database.state` and the connection use.
2. Who waits for whom:

   ```sql
   SELECT pid, state, wait_event_type, wait_event, now() - query_start AS running, left(query, 80)
   FROM pg_stat_activity WHERE datname = current_database() AND state <> 'idle' ORDER BY running DESC;
   ```

   Many `Lock` waits behind one long transaction: find and end that session (`SELECT pg_terminate_backend(<pid>)`) after
   you know what it is. A migration or a manual `UPDATE` on a big table is the usual one.
3. Dead rows: `SELECT relname, n_dead_tup, last_autovacuum FROM pg_stat_user_tables WHERE relname LIKE 'qcloud\_%' ORDER BY n_dead_tup DESC;`.
   A very high count on a busy table with an old `last_autovacuum` means autovacuum is behind.
4. Is the pool the bottleneck? A worker with a high `concurrency` and the default pool of 2 queues its claims behind
   its own heartbeats and settles. The worker's `claim_ms` rises while the database looks idle.

## Fix

- Lock: end the blocking session. Autovacuum: run `VACUUM (ANALYZE)` on the table off-peak, and check retention is running
  ([the tick](tick-stopped.md)); old finished jobs make every table larger.
- Pool: raise `QCLOUD_DATABASE_POOL_SIZE` a little, after recounting [the connection budget](connection-exhaustion.md).
- Load: lower the queue's concurrency (`PUT /queues/{queue}/concurrency`) or rate (`PUT /queues/{queue}/rate-limit`) until the
  database recovers, then lift it (`DELETE` on the same paths).

## Verify

`claim_ms` p99 falls under the threshold and the alert closes; waiting jobs start without a gap.

## Escalate

The database is idle, the pool is large enough and claims are still slow: capture one `EXPLAIN (ANALYZE, BUFFERS)` of the claim
from the slow-query log and open an issue. Every query path has an index test, so a missing index is a bug.
