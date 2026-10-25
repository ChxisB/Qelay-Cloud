import type { Route } from '../http/router';
import { backupPolicyBody, toBackupPolicyWire } from '../jobs/backupModel';
import type { JobsContext } from '../jobs/context';

/**
 * How the operator says this database is backed up (DESIGN.md D18). Qelay takes no backups, so this only records the
 * answer: `provider` (the managed database's own backups), `external` (the operator's tooling, named, and where its copies
 * land) or `none`. `policy` is null while nobody has said. The Deployment page warns for null and for `none`.
 */
export function backupPolicyRoutes(ctx: JobsContext): Route[] {
  const { store } = ctx;

  return [
    {
      method: 'GET',
      path: '/backup-policy',
      access: 'read',
      async handle() {
        const policy = await store.backups.get();
        return { ok: true, data: { policy: policy && toBackupPolicyWire(policy) } };
      },
    },
    {
      method: 'PUT',
      path: '/backup-policy',
      access: 'write',
      async handle(context) {
        const body = await context.json(backupPolicyBody);
        const policy = await store.backups.set(body, context.principal!.subject);
        context.audit(`backupPolicy ${policy.mechanism}`);
        return { ok: true, data: { policy: toBackupPolicyWire(policy) } };
      },
    },
  ];
}
