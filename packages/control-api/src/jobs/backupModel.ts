import type { BackupPolicy } from '@qelay-cloud/store-postgres';
import {
  BACKUP_MECHANISMS,
  checkBackupPolicy,
  MAX_BACKUP_LOCATION_CHARS,
  MAX_BACKUP_TOOL_CHARS,
} from '@qelay-cloud/store-postgres';
import { z } from 'zod';

/**
 * `PUT /backup-policy` (DESIGN.md D18): how the operator says the database is backed up. The rules are the store's
 * (`checkBackupPolicy`), so a body the route accepts is one the store accepts. The bounds only keep the body small.
 */
export const backupPolicyBody = z
  .strictObject({
    mechanism: z.enum(BACKUP_MECHANISMS),
    tool: z
      .string()
      .max(MAX_BACKUP_TOOL_CHARS * 2)
      .nullable()
      .optional(),
    location: z
      .string()
      .max(MAX_BACKUP_LOCATION_CHARS * 2)
      .nullable()
      .optional(),
  })
  .superRefine((body, ctx) => {
    const broken = checkBackupPolicy(body);
    if (broken) ctx.addIssue({ code: 'custom', path: [broken.field], message: broken.problem });
  });

export interface BackupPolicyWire {
  readonly mechanism: BackupPolicy['mechanism'];
  readonly tool: string | null;
  readonly location: string | null;
  readonly updatedBy: string;
  readonly updatedAt: number;
}

export const toBackupPolicyWire = (policy: BackupPolicy): BackupPolicyWire => ({
  mechanism: policy.mechanism,
  tool: policy.tool,
  location: policy.location,
  updatedBy: policy.updatedBy,
  updatedAt: policy.updatedAt,
});
