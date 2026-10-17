import { ApiError } from '../errors';
import type { Route } from '../http/router';
import type { JobsContext } from '../jobs/context';

/**
 * The few calls of the panel's server page that mean something on a managed queue.
 *
 * `/ping` and `/storage` are cheap constants of the process (the database is checked by
 * `/health/ready`, not here). `/gc`, `/heapstats` and `/prometheus` belong to a Qelay server
 * process the panel can manage and answer 501 under the hidden `serverControl` capability, like
 * the rest of that page.
 */
export function serverStatusRoutes(ctx: JobsContext): Route[] {
  const closed = (): never => {
    throw ApiError.notSupported(
      'serverControl',
      'serverControl does not apply to a managed queue: this deployment has no such feature'
    );
  };

  return [
    {
      method: 'GET',
      path: '/ping',
      access: 'read',
      handle: () => ({ ok: true, data: { pong: true, time: ctx.clock.now() } }),
    },
    {
      method: 'GET',
      path: '/storage',
      access: 'read',
      // Postgres is the store and a full disk is the provider's to report (health/ready fails first).
      handle: () => ({ ok: true, data: { diskFull: false, error: null, since: null } }),
    },
    { method: 'POST', path: '/gc', access: 'write', handle: closed },
    { method: 'GET', path: '/heapstats', access: 'read', handle: closed },
    { method: 'GET', path: '/prometheus', access: 'read', handle: closed },
  ];
}
