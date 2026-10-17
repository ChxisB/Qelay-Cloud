import {
  ASSIGN_EVENT_COMMIT_BODY,
  REGISTER_EVENT_ROWS_BODY,
  REGISTER_WATERMARK_ROWS_BODY,
  TRACK_EVENT_DELETIONS_BODY,
  TRACK_EVENT_INSERTIONS_BODY,
} from './eventFunctions';

/**
 * Version 1 DDL, part 3: the event log, its commit-time sequencer and its retention counters.
 * Adapted from Qelay's `schema.ts`, `eventJournalSchema.ts` and `eventRetentionSchema.ts`. Upstream
 * reached this shape through a series of `ALTER`s and backfills; here the tables are created in
 * their final form.
 *
 * Why a sequencer: event ids come from a sequence at insert time, so a reader polling `id > cursor`
 * could skip a row whose transaction commits after a row with a later id. A deferred constraint
 * trigger assigns `commit_seq` at commit, under a per-namespace advisory lock (transaction-scoped,
 * so it survives a transaction pooler), and readers follow `commit_seq`.
 */
export const EVENT_STATEMENTS: readonly string[] = [
  `CREATE TABLE qcloud_events (
  id BIGSERIAL PRIMARY KEY,
  namespace TEXT NOT NULL,
  queue TEXT NOT NULL,
  event_type TEXT NOT NULL,
  job_id TEXT NOT NULL,
  occurred_at BIGINT NOT NULL,
  payload BYTEA,
  transaction_id BIGINT NOT NULL DEFAULT (pg_current_xact_id()::text::bigint)
)`,
  `CREATE INDEX qcloud_events_namespace_id_idx
  ON qcloud_events(namespace, id)`,
  `CREATE INDEX qcloud_events_queue_id_idx
  ON qcloud_events(namespace, queue, id DESC)`,
  `CREATE INDEX qcloud_events_transaction_idx
  ON qcloud_events(namespace, transaction_id, id)`,

  `CREATE TABLE qcloud_event_prune_watermarks (
  namespace TEXT NOT NULL,
  queue TEXT NOT NULL,
  source_event_id BIGINT NOT NULL,
  pruned_through BIGINT NOT NULL,
  transaction_id BIGINT NOT NULL DEFAULT (pg_current_xact_id()::text::bigint),
  commit_seq BIGINT,
  pruned_commit_seq BIGINT NOT NULL DEFAULT 0,
  self_pruned_commit_seq BIGINT NOT NULL DEFAULT 0,
  prunes_current_transaction BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (namespace, queue, source_event_id)
)`,
  // No index on (namespace, queue, pruned_through) or on (namespace, transaction_id) alone: the table
  // holds about one row per queue, every lookup by (namespace, queue) is a prefix of the primary key,
  // and the transaction lookup always carries commit_seq IS NULL (the partial index below).
  `CREATE INDEX qcloud_event_prune_watermarks_commit_idx
  ON qcloud_event_prune_watermarks(namespace, queue, commit_seq DESC)
  WHERE commit_seq IS NOT NULL`,
  `CREATE INDEX qcloud_event_prune_watermarks_pending_commit_idx
  ON qcloud_event_prune_watermarks(namespace, transaction_id)
  WHERE commit_seq IS NULL`,

  `CREATE SEQUENCE qcloud_event_commit_seq AS BIGINT
  INCREMENT BY 1 NO MINVALUE NO MAXVALUE NO CYCLE CACHE 1`,
  `CREATE TABLE qcloud_event_commits (
  namespace TEXT NOT NULL,
  transaction_id BIGINT NOT NULL,
  commit_seq BIGINT,
  PRIMARY KEY (namespace, transaction_id)
)`,
  `CREATE INDEX qcloud_event_commits_replay_idx
  ON qcloud_event_commits(namespace, commit_seq, transaction_id)
  WHERE commit_seq IS NOT NULL`,

  // Exact retained-event counters, kept by statement-level triggers on the event table.
  `CREATE TABLE qcloud_event_retention_state (
  namespace TEXT NOT NULL,
  queue TEXT NOT NULL,
  retained_count BIGINT NOT NULL DEFAULT 0,
  last_event_id BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (namespace, queue)
)`,
  `CREATE TABLE qcloud_event_retention_deltas (
  namespace TEXT NOT NULL,
  queue TEXT NOT NULL,
  transaction_id BIGINT NOT NULL,
  delta_count BIGINT NOT NULL,
  last_event_id BIGINT NOT NULL,
  PRIMARY KEY (namespace, queue, transaction_id)
)`,

  `CREATE FUNCTION qcloud_register_event_rows()
RETURNS TRIGGER LANGUAGE plpgsql AS $function$
${REGISTER_EVENT_ROWS_BODY}
$function$`,
  `CREATE FUNCTION qcloud_register_watermark_rows()
RETURNS TRIGGER LANGUAGE plpgsql AS $function$
${REGISTER_WATERMARK_ROWS_BODY}
$function$`,
  `CREATE FUNCTION qcloud_assign_event_commit()
RETURNS TRIGGER LANGUAGE plpgsql AS $function$
${ASSIGN_EVENT_COMMIT_BODY}
$function$`,
  `CREATE FUNCTION qcloud_track_event_insertions()
RETURNS TRIGGER LANGUAGE plpgsql AS $function$
${TRACK_EVENT_INSERTIONS_BODY}
$function$`,
  `CREATE FUNCTION qcloud_track_event_deletions()
RETURNS TRIGGER LANGUAGE plpgsql AS $function$
${TRACK_EVENT_DELETIONS_BODY}
$function$`,

  // Triggers on one event fire in name order: register_commit, then track_retention_*.
  `CREATE TRIGGER qcloud_events_register_commit
AFTER INSERT ON qcloud_events
REFERENCING NEW TABLE AS new_event_rows
FOR EACH STATEMENT EXECUTE FUNCTION qcloud_register_event_rows()`,
  `CREATE TRIGGER qcloud_events_track_retention_insert
AFTER INSERT ON qcloud_events
REFERENCING NEW TABLE AS new_event_rows
FOR EACH STATEMENT EXECUTE FUNCTION qcloud_track_event_insertions()`,
  `CREATE TRIGGER qcloud_events_track_retention_delete
AFTER DELETE ON qcloud_events
REFERENCING OLD TABLE AS old_event_rows
FOR EACH STATEMENT EXECUTE FUNCTION qcloud_track_event_deletions()`,
  `CREATE TRIGGER qcloud_watermarks_insert_register_commit
AFTER INSERT ON qcloud_event_prune_watermarks
REFERENCING NEW TABLE AS new_watermark_rows
FOR EACH STATEMENT EXECUTE FUNCTION qcloud_register_watermark_rows()`,
  `CREATE TRIGGER qcloud_watermarks_update_register_commit
AFTER UPDATE ON qcloud_event_prune_watermarks
REFERENCING NEW TABLE AS new_watermark_rows
FOR EACH STATEMENT EXECUTE FUNCTION qcloud_register_watermark_rows()`,
  `CREATE CONSTRAINT TRIGGER qcloud_assign_event_commit
AFTER INSERT ON qcloud_event_commits
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION qcloud_assign_event_commit()`,
];
