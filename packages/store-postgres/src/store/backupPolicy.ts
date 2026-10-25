import { UnsupportedOptionError } from '@qelay-cloud/core';
import type { StoreContext } from './context';
import { runTransaction } from './retry';

/**
 * How the operator says this database is backed up (migration 25, DESIGN.md D18). Qelay takes no backups: the row is
 * a declaration the Control API shows, and the Deployment page warns when there is none or when it is `none`.
 */

export const BACKUP_MECHANISMS = ['provider', 'external', 'none'] as const;
export type BackupMechanism = (typeof BACKUP_MECHANISMS)[number];

export const MAX_BACKUP_TOOL_CHARS = 200;
export const MAX_BACKUP_LOCATION_CHARS = 500;
const MAX_UPDATED_BY_CHARS = 200;

export interface BackupPolicySpec {
  readonly mechanism: BackupMechanism;
  /** `external` only, and required there: what takes the copies (`pgBackRest`, `a nightly pg_dump job`). */
  readonly tool?: string | null;
  /** `external` only: where the copies land, as the operator would say it. */
  readonly location?: string | null;
}

export interface BackupPolicy {
  readonly mechanism: BackupMechanism;
  readonly tool: string | null;
  readonly location: string | null;
  readonly updatedBy: string;
  readonly updatedAt: number;
}

export interface BackupPolicyApi {
  /** What the operator declared; null while nobody has. */
  get(): Promise<BackupPolicy | null>;
  /** Replaces the declaration. `updatedBy` is the operator's subject. Throws `UnsupportedOptionError` for a spec that breaks `checkBackupPolicy`. */
  set(spec: BackupPolicySpec, updatedBy: string): Promise<BackupPolicy>;
}

const blank = (value: string | null | undefined): boolean => value == null || value.trim() === '';

/** The first rule a spec breaks, or null. The Control API checks a body with it before the store does. */
export function checkBackupPolicy(
  spec: BackupPolicySpec
): { field: string; problem: string } | null {
  if (!BACKUP_MECHANISMS.includes(spec.mechanism)) {
    return { field: 'mechanism', problem: `must be one of ${BACKUP_MECHANISMS.join(', ')}` };
  }
  if (spec.mechanism !== 'external') {
    if (!blank(spec.tool)) return { field: 'tool', problem: 'only applies to external backups' };
    if (!blank(spec.location))
      return { field: 'location', problem: 'only applies to external backups' };
    return null;
  }
  if (blank(spec.tool)) return { field: 'tool', problem: 'is required for external backups' };
  if (spec.tool!.trim().length > MAX_BACKUP_TOOL_CHARS) {
    return { field: 'tool', problem: `is over ${MAX_BACKUP_TOOL_CHARS} characters` };
  }
  if ((spec.location?.trim().length ?? 0) > MAX_BACKUP_LOCATION_CHARS) {
    return { field: 'location', problem: `is over ${MAX_BACKUP_LOCATION_CHARS} characters` };
  }
  return null;
}

interface Row {
  mechanism: BackupMechanism;
  tool: string | null;
  location: string | null;
  updated_by: string;
  updated_at: number | string;
}

const COLUMNS = 'mechanism, tool, location, updated_by, updated_at';

const policyOf = (row: Row): BackupPolicy => ({
  mechanism: row.mechanism,
  tool: row.tool,
  location: row.location,
  updatedBy: row.updated_by,
  updatedAt: Number(row.updated_at),
});

export async function getBackupPolicy(ctx: StoreContext): Promise<BackupPolicy | null> {
  return ctx.db.run('getBackupPolicy', async (sql) => {
    const [row] = await sql.unsafe<Row[]>(
      `SELECT ${COLUMNS} FROM qcloud_backup_policy WHERE namespace = $1`,
      [ctx.namespace]
    );
    return row ? policyOf(row) : null;
  });
}

export async function setBackupPolicy(
  ctx: StoreContext,
  spec: BackupPolicySpec,
  updatedBy: string
): Promise<BackupPolicy> {
  const broken = checkBackupPolicy(spec);
  if (broken) throw new UnsupportedOptionError(broken.field, broken.problem);
  if (updatedBy === '') throw new UnsupportedOptionError('updatedBy', 'must be a non-empty string');
  const external = spec.mechanism === 'external';
  return ctx.db.run('setBackupPolicy', (sql) =>
    runTransaction(sql, async (tx) => {
      const now = await ctx.db.time.now(tx);
      const [row] = await tx.unsafe<Row[]>(
        `INSERT INTO qcloud_backup_policy (namespace, mechanism, tool, location, updated_by, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (namespace) DO UPDATE
           SET mechanism = EXCLUDED.mechanism, tool = EXCLUDED.tool, location = EXCLUDED.location,
               updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at
         RETURNING ${COLUMNS}`,
        [
          ctx.namespace,
          spec.mechanism,
          external ? spec.tool!.trim() : null,
          external && !blank(spec.location) ? spec.location!.trim() : null,
          updatedBy.slice(0, MAX_UPDATED_BY_CHARS),
          now,
        ]
      );
      return policyOf(row!);
    })
  );
}

export const backupPolicyApi = (ctx: StoreContext): BackupPolicyApi => ({
  get: () => getBackupPolicy(ctx),
  set: (spec, updatedBy) => setBackupPolicy(ctx, spec, updatedBy),
});
