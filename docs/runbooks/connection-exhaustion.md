# Runbook: database connections near the limit

**Alert.** GCP: "<name>: database connections". AWS: `<name>-database-connections`. `GET /deployment`: `connections_high`,
`connections_exhausted` or `connection_budget_exceeded`. At the limit Postgres refuses with `53300` and the process retries.

**What is safe.** The pools are small and a connection is held for one statement or a short transaction, so adding workers is
what spends connections, not running longer jobs. Scaling workers **down** is always safe: a worker that is stopped releases
its jobs and the tick recovers what it could not.

## Check

1. `GET /deployment` gives `connections` (in use, `maxConnections`, what the declared fleet needs). If `needed` is above
   `maxConnections`, the fleet does not fit: it is a sizing problem, not a leak ([the budget](../operations.md#connection-budget)).
2. If the fleet fits and use is still high, something is holding connections. On the database:

   ```sql
   SELECT application_name, state, count(*) FROM pg_stat_activity GROUP BY 1, 2 ORDER BY 3 DESC;
   ```

   The API, the tick and the migration name themselves (`qcloud-api`, `qcloud-tick`, `qcloud-migrate`); your workers do so only if you set `database.applicationName`. Many `idle in transaction` entries mean a
   process is stuck mid-transaction; many `idle` from one name is a pool larger than you set or more instances than you
   counted.
3. Did the fleet grow? Autoscaling can raise instances above what `QCLOUD_FLEET_WORKERS` told the API.

## Fix

- Lower `max_instances` or the pool size (`QCLOUD_DATABASE_POOL_SIZE`, default 2) until the sum fits: the formula is in
  [operations](../operations.md#connection-budget), and Terraform refuses to plan a fleet that does not fit.
- Raise `max_connections` on the database, or put a transaction-mode pooler in front and set
  `QCLOUD_DATABASE_POOLER=transaction` ([operations](../operations.md#connection-budget)). A pooler is another stateful
  service; neither Terraform creates one.
- A stuck process: restart that revision or task; its connections close and the tick recovers its jobs.

## Verify

`GET /deployment` shows `connections.inUse` under 80% of `maxConnections` and no `connections_*` warning; the alert closes.

## Escalate

Use stays high with a fleet that fits and no idle-in-transaction sessions: capture `pg_stat_activity` and the process list and
treat it as a connection leak in the SDK. Open an issue with those two outputs; do not paste connection strings.
