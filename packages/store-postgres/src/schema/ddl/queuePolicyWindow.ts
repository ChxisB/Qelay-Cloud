/**
 * Version 23 DDL: a queue can carry a retry policy and a run window (DESIGN.md D17). Every column is nullable and no
 * existing column changes, so a release that does not know them reads and writes `qcloud_queue_state` as before.
 *
 * - `policy`: the queue's default `{ attempts, backoff, timeout }`, a JSON object. The store reads it at enqueue and
 *   copies what applies onto the job row; the claim and fail paths never read it. The fields are checked by the Control
 *   API and the store when it is saved (SQL checks only that it is an object). A release that predates this version
 *   ignores it, so jobs it enqueues take the built-in defaults.
 * - `run_window`: when the queue may start jobs, `{ cron, durationMs, timezone? }`, a JSON object. The expression is
 *   checked by the store's cron parser when it is saved (SQL cannot parse it).
 * - `window_from`, `window_until`: the window as one interval of epoch milliseconds, the one that contains now or the
 *   next one to come. The claim compares two integers and parses nothing; the tick moves the interval on. All three
 *   are set or none, and the interval is not empty. A release that predates this version claims from a queue whose
 *   window is closed, so set a window only after every process runs this release.
 *
 * One partial index, `qcloud_queue_state_window_idx`, lets the tick find the windows that ended without reading every
 * queue; it holds a row only for a queue that has a window. Nothing marks an opening: the tick's ring query skips a
 * queue while its window is closed, so the bells its jobs got before are old when it opens, and the re-ring finds them.
 */
export const QUEUE_POLICY_WINDOW_STATEMENTS: readonly string[] = [
  `ALTER TABLE qcloud_queue_state
  ADD COLUMN policy JSONB CHECK (policy IS NULL OR jsonb_typeof(policy) = 'object'),
  ADD COLUMN run_window JSONB CHECK (run_window IS NULL OR jsonb_typeof(run_window) = 'object'),
  ADD COLUMN window_from BIGINT,
  ADD COLUMN window_until BIGINT,
  ADD CONSTRAINT qcloud_queue_state_window_check CHECK (
    (run_window IS NULL) = (window_from IS NULL)
    AND (window_from IS NULL) = (window_until IS NULL)
    AND (window_from IS NULL OR window_until > window_from))`,
  `CREATE INDEX qcloud_queue_state_window_idx ON qcloud_queue_state (namespace, window_until)
  WHERE run_window IS NOT NULL`,
];
