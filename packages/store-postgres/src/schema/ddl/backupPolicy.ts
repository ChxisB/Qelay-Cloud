/**
 * Version 25 DDL: how the operator says this deployment's database is backed up (DESIGN.md D18). A new table and nothing
 * else, so a release that does not know it reads and writes every other table as before.
 *
 * Qelay does not take backups. The row only records the answer, so the Control API can show it and the Deployment page can
 * warn when there is none. One row per namespace; no row means nobody has said.
 *
 * - `provider`: the managed database's own backups (Cloud SQL, RDS). Nothing else is recorded.
 * - `external`: the operator's own tooling outside Qelay. `tool` names it; `location` says where the copies land.
 * - `none`: the operator has decided not to back this database up.
 */
export const BACKUP_POLICY_STATEMENTS: readonly string[] = [
  `CREATE TABLE qcloud_backup_policy (
  namespace TEXT PRIMARY KEY,
  mechanism TEXT NOT NULL CHECK (mechanism IN ('provider', 'external', 'none')),
  tool TEXT,
  location TEXT,
  updated_by TEXT NOT NULL,
  updated_at BIGINT NOT NULL,
  CHECK ((mechanism = 'external') = (tool IS NOT NULL)),
  CHECK (mechanism = 'external' OR location IS NULL)
)`,
];
