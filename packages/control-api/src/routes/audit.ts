import type { AuditApi } from '@qelay-cloud/store-postgres';
import { z } from 'zod';
import { ApiError } from '../errors';
import type { Route } from '../http/router';

const auditQuery = z.object({
  limit: z.coerce.number().int().min(1).optional(),
  before: z.coerce.number().int().min(1).optional(),
  subject: z.string().min(1).max(256).optional(),
  action: z.string().min(1).max(160).optional(),
  outcome: z.enum(['pending', 'success', 'rejected', 'failed']).optional(),
});

/**
 * `GET /audit`: the operator audit log, newest first, `before` an entry id for the next page. An
 * entry says who did what to which identifiers and how it ended, never a body or a payload.
 *
 * It lists other people's subjects, so it needs the operator role even though it only reads (a
 * viewer gets 403). Without an audit log configured it answers 501, as mutations then are not
 * audited either.
 */
export function auditRoutes(log: AuditApi | undefined): Route[] {
  return [
    {
      method: 'GET',
      path: '/audit',
      access: 'read',
      operatorOnly: true,
      async handle(context) {
        if (log === undefined) {
          throw new ApiError(
            501,
            'not_implemented',
            'no audit log is configured for this deployment'
          );
        }
        const query = context.query(auditQuery);
        const page = await log.list({
          ...(query.limit === undefined ? {} : { limit: query.limit }),
          ...(query.before === undefined ? {} : { before: query.before }),
          ...(query.subject === undefined ? {} : { subject: query.subject }),
          ...(query.action === undefined ? {} : { action: query.action }),
          ...(query.outcome === undefined ? {} : { outcome: query.outcome }),
        });
        return { ok: true, entries: page.items, next: page.next };
      },
    },
  ];
}
