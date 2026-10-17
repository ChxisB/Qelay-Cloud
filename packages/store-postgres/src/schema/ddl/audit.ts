/**
 * Version 5 DDL: the operator audit log. One row per operator mutation of the Control API: who
 * (the token's subject, never the token), what (the route and the identifiers in its path), when,
 * and how it ended. It holds no payloads: a row is a fixed set of short strings, so it cannot leak
 * job data and its size is bounded by the count and age caps the store applies when it appends.
 * A new table, so releases that do not know it are unaffected. See `store/audit.ts`.
 *
 * `outcome` is `pending` from the moment the operation is accepted until it finishes, so a process
 * that dies in the middle leaves the intent on record. The listing is newest first by `id`; the
 * time index serves the retention cut.
 */
export const AUDIT_STATEMENTS: readonly string[] = [
  `CREATE TABLE qcloud_audit (
  id BIGSERIAL PRIMARY KEY,
  namespace TEXT NOT NULL,
  occurred_at BIGINT NOT NULL,
  finished_at BIGINT,
  subject TEXT NOT NULL,
  role TEXT NOT NULL,
  source TEXT NOT NULL,
  request_id TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT NOT NULL DEFAULT '',
  outcome TEXT NOT NULL,
  status INTEGER,
  reason TEXT
)`,
  `CREATE INDEX qcloud_audit_namespace_id_idx
  ON qcloud_audit(namespace, id DESC)`,
  `CREATE INDEX qcloud_audit_namespace_time_idx
  ON qcloud_audit(namespace, occurred_at)`,
];
