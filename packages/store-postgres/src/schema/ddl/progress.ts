/**
 * Version 3 DDL: job progress. `Job.updateProgress` needs somewhere to keep the value, and
 * version 1 has no column for it. Both columns are additive and defaulted (a worker on the previous
 * release neither reads nor writes them), so the migration is safe while old workers are connected.
 *
 * `progress` is the number a processor reported, clamped to 0..100 by the writer; `progress_message`
 * carries the text of an object or string progress (BullMQ allows both). See `store/jobEdits.ts`.
 */
export const PROGRESS_STATEMENTS: readonly string[] = [
  `ALTER TABLE qcloud_jobs ADD COLUMN progress DOUBLE PRECISION NOT NULL DEFAULT 0`,
  `ALTER TABLE qcloud_jobs ADD COLUMN progress_message TEXT`,
];
