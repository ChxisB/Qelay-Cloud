/**
 * Version 24 DDL: the index the tick's removal of old completed jobs reads (`store/completedRetention.ts`). One partial
 * index and nothing else, so a release that predates it reads and writes every table as before; it only has one more
 * index to keep when it completes a job.
 *
 * The index holds a row only for a job in the `completed` state, ordered by when it finished, so the oldest finished job
 * of a namespace is the first entry and "nothing is old enough yet" is one probe, however many completed jobs are kept.
 * `qcloud_jobs_state_idx` cannot answer that: it orders by creation inside a queue, so a pass would walk every kept job
 * to learn that none is old enough. Building it takes a lock that blocks writes to `qcloud_jobs` until it is done
 * (the migrator runs in a transaction, which rules out `CONCURRENTLY`), so on a table of many millions of rows run the
 * release step in a quiet minute.
 */
export const COMPLETED_RETENTION_STATEMENTS: readonly string[] = [
  `CREATE INDEX qcloud_jobs_completed_idx
  ON qcloud_jobs(namespace, completed_at, id)
  WHERE state = 'completed'`,
];
