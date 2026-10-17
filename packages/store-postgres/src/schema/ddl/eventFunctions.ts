/**
 * PL/pgSQL bodies of the event journal and retention triggers. Copied unchanged from Qelay's
 * `eventJournalSchema.ts` and `eventRetentionSchema.ts` (the rename to the `qcloud` prefix is the
 * only difference from upstream's text). These bodies decide event ordering under concurrent
 * writers, so edit them only with a new migration and the model harness.
 */
export const REGISTER_EVENT_ROWS_BODY = `BEGIN
  INSERT INTO qcloud_event_commits (namespace, transaction_id)
  SELECT DISTINCT namespace, transaction_id FROM new_event_rows
  ORDER BY namespace, transaction_id
  ON CONFLICT DO NOTHING;
  RETURN NULL;
END;`;

export const REGISTER_WATERMARK_ROWS_BODY = `BEGIN
  INSERT INTO qcloud_event_commits (namespace, transaction_id)
  SELECT DISTINCT namespace, transaction_id FROM new_watermark_rows
  ORDER BY namespace, transaction_id
  ON CONFLICT DO NOTHING;
  RETURN NULL;
END;`;

export const ASSIGN_EVENT_COMMIT_BODY = `DECLARE
  assigned_commit_seq BIGINT;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'qcloud:event-commit:' || length(NEW.namespace)::text || ':' || NEW.namespace,
    0
  ));
  assigned_commit_seq := nextval('qcloud_event_commit_seq');

  UPDATE qcloud_event_commits
  SET commit_seq = assigned_commit_seq
  WHERE namespace = NEW.namespace
    AND transaction_id = NEW.transaction_id
    AND commit_seq IS NULL;
  UPDATE qcloud_event_prune_watermarks
  SET commit_seq = assigned_commit_seq,
      pruned_commit_seq = CASE
        WHEN prunes_current_transaction THEN GREATEST(
          COALESCE(pruned_commit_seq, 0), assigned_commit_seq
        )
        ELSE pruned_commit_seq
      END,
      self_pruned_commit_seq = CASE
        WHEN prunes_current_transaction THEN GREATEST(
          COALESCE(self_pruned_commit_seq, 0), assigned_commit_seq
        )
        ELSE self_pruned_commit_seq
      END,
      prunes_current_transaction = FALSE
  WHERE namespace = NEW.namespace
    AND transaction_id = NEW.transaction_id
    AND commit_seq IS NULL;
  RETURN NULL;
END;`;

export const TRACK_EVENT_INSERTIONS_BODY = `BEGIN
  INSERT INTO qcloud_event_retention_deltas
    (namespace, queue, transaction_id, delta_count, last_event_id)
  SELECT
    namespace,
    queue,
    pg_current_xact_id()::text::bigint,
    COUNT(*)::BIGINT,
    MAX(id)
  FROM new_event_rows
  GROUP BY namespace, queue
  ORDER BY namespace, queue
  ON CONFLICT (namespace, queue, transaction_id) DO UPDATE SET
    delta_count = qcloud_event_retention_deltas.delta_count
      + excluded.delta_count,
    last_event_id = GREATEST(
      qcloud_event_retention_deltas.last_event_id,
      excluded.last_event_id
    );
  RETURN NULL;
END;`;

export const TRACK_EVENT_DELETIONS_BODY = `BEGIN
  INSERT INTO qcloud_event_retention_deltas
    (namespace, queue, transaction_id, delta_count, last_event_id)
  SELECT
    namespace,
    queue,
    pg_current_xact_id()::text::bigint,
    -COUNT(*)::BIGINT,
    MAX(id)
  FROM old_event_rows
  GROUP BY namespace, queue
  ORDER BY namespace, queue
  ON CONFLICT (namespace, queue, transaction_id) DO UPDATE SET
    delta_count = qcloud_event_retention_deltas.delta_count
      + excluded.delta_count,
    last_event_id = GREATEST(
      qcloud_event_retention_deltas.last_event_id,
      excluded.last_event_id
    );
  RETURN NULL;
END;`;
