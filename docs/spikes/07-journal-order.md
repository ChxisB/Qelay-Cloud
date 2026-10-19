# Spike 07: the journal's commit lock, and the reader that would replace it

Review finding F1 (2026-10-19). Status: **steps 1 and 2 are done or planned; step 3 is designed and not built, on purpose.**

## The cost

An event-writing commit takes `pg_advisory_xact_lock` on its namespace in a deferred trigger and holds it until the commit
is durable ([`eventFunctions.ts`](../../packages/store-postgres/src/schema/ddl/eventFunctions.ts)). Two commits of one namespace
cannot overlap their flush, so the namespace's commit rate is at most one over the commit time, and database-side group commit
cannot help. At a 2 ms commit that is 500 a second; at 0.2 ms, 5,000. The 2 ms is an assumption: it has not been measured on a
managed instance (F17).

## The ladder

1. **A batch is one pass.** `enqueue` of N jobs, `completeMany` and the worker's `groupCommit` and `groupComplete` write
   many jobs' events in one transaction. `journal.lockPasses.test.ts` pins it: 50 jobs one by one are 50 sequence steps
   (one per lock pass), in one call 1. Done (R02, R09).
2. **Spread hot queues over namespaces.** The lock is per namespace. Planned as task R21 (sharding by namespace).
3. **Replace the lock with a reader that follows the transaction-id horizon.** Not built.

## What step 3 would be

Give each commit `commit_seq = transaction_id` (the xid, already stored) at insert time, with no lock, no `nextval` and no
deferred trigger, and make a reader take only commits below `pg_snapshot_xmin(pg_current_snapshot())`: every transaction
below that horizon has finished, so what a reader has passed cannot gain a row. The cursor keeps its shape. A new migration
replaces the two trigger bodies; readers (`journal.ts`) gain the horizon bound; `eventBaseline` and the retention watermarks
(`pruned_commit_seq`) move to the xid space. Old readers see commits in the same shape, but a mixed fleet needs the usual two
releases: first readers that understand both, then the writers.

## Why it was not built here

- **It weakens a guarantee.** Today events come in commit order, so a job's events are in the order they happened
  (`journal.cost.test.ts` checks it under eight claimers). By xid order, two transactions that both lock the same job can
  commit in the opposite order to their xids (the one with the lower xid waited on a row the other locked later), so a
  job's events can swap. Events are hints and the jobs are the truth, but webhooks and the event stream say "in order".
- **It adds a stall.** The horizon is held back by the oldest open transaction that has an xid, anywhere in the database: a
  long migration, a forgotten `BEGIN` after a write, a prepared transaction. Every reader (event stream, webhook sender) then
  stops advancing until it ends. Today only a lock holder can block, and only for its own commit.
- **The premise is unmeasured.** The artifact itself says to measure commit time on the real instance first. If it is 0.5 ms the
  cap is 2,000 a second a namespace, and steps 1 and 2 already carry the target. That measurement is a real-cloud run and
  needs the owner's go-ahead (D9).
- **It rewrites ported ordering code**, which needs the model harness extended to xid ordering and a second look at the
  retention watermarks, which assign `commit_seq` under the same lock.

## Decision for the owner

After the load check (F17) gives a commit time: if 1 / commit time, times the namespaces in use, is below the target, build
step 3, and decide then whether a swap of one job's events in a rare race and a stall behind a long write transaction are
acceptable (a `maxAge` alert on the horizon would make the stall visible). Until then the journal keeps its lock.
