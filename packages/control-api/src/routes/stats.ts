import { wantsFresh } from '../cache';
import type { ControlApiDeps } from '../deps';
import { ApiError } from '../errors';
import type { Route } from '../http/router';

const notWired = (what: string): ApiError =>
  new ApiError(501, 'not_implemented', `${what} is not served by this deployment yet`);

/**
 * `GET /dashboard` and `GET /stats`. The response types are in `../types`; the reads come from the
 * jobs and queues routes, which pass a `DashboardReader`. Until one is given both answer 501.
 */
export function statsRoutes(deps: ControlApiDeps): Route[] {
  return [
    {
      method: 'GET',
      path: '/dashboard',
      access: 'read',
      handle: (context) => {
        if (deps.dashboard === undefined) throw notWired('the dashboard overview');
        return deps.dashboard.overview({ fresh: wantsFresh(context.request) });
      },
    },
    {
      method: 'GET',
      path: '/stats',
      access: 'read',
      handle: (context) => {
        if (deps.dashboard === undefined) throw notWired('the statistics');
        return deps.dashboard.stats({ fresh: wantsFresh(context.request) });
      },
    },
  ];
}
