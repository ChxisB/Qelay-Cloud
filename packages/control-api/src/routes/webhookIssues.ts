import { ApiError } from '../errors';
import type { Route } from '../http/router';
import type { JobsContext } from '../jobs/context';
import { issueBody, issuesQuery, toIssueWire } from '../jobs/webhookIssueModel';
import type { Role } from '../types';

/**
 * Issues (D13): `GET /webhooks/issues` lists one status of them with the count of every status, and
 * `PUT /webhooks/issues/:id` is an operator acknowledging, ignoring, reopening or resolving one. A failing
 * delivery opens an issue and a delivered one resolves it, in the store; this is only the operator's say.
 * The literal path wins over `/webhooks/:id`. The audit target is the issue id (`id=<n>`), never the route's URL.
 */
export function webhookIssueRoutes(ctx: JobsContext): Route[] {
  const { store } = ctx;
  const roleOf = (principal: { readonly role: Role } | null): Role => principal?.role ?? 'viewer';

  return [
    {
      method: 'GET',
      path: '/webhooks/issues',
      access: 'read',
      async handle(context) {
        const query = context.query(issuesQuery);
        const [page, counts, routes] = await Promise.all([
          store.webhooks.issues({
            status: query.status ?? 'open',
            ...(query.webhook === undefined ? {} : { webhook: query.webhook }),
            ...(query.limit === undefined ? {} : { limit: query.limit }),
            ...(query.before === undefined ? {} : { before: query.before }),
          }),
          store.webhooks.issueCounts(),
          store.webhooks.list(),
        ]);
        const byId = new Map(routes.map((route) => [route.id, route]));
        const role = roleOf(context.principal);
        return {
          ok: true,
          data: {
            issues: page.items.map((issue) => toIssueWire(issue, byId.get(issue.webhookId), role)),
            next: page.next,
            counts,
          },
        };
      },
    },
    {
      method: 'PUT',
      path: '/webhooks/issues/:id',
      access: 'write',
      async handle(context) {
        const body = await context.json(issueBody);
        const id = context.params.id!;
        const result = await store.webhooks.setIssueStatus(
          id,
          body.status,
          context.principal?.subject ?? 'unknown'
        );
        if (result.outcome === 'not_found') {
          throw new ApiError(404, 'issue_not_found', 'issue not found', { issueId: id });
        }
        if (result.outcome === 'resolved') {
          throw new ApiError(
            409,
            'issue_resolved',
            'the issue is resolved, which is history: the next failure opens a new one',
            { issueId: id }
          );
        }
        const route = await store.webhooks.get(result.issue.webhookId);
        return {
          ok: true,
          data: { issue: toIssueWire(result.issue, route ?? undefined, 'operator') },
        };
      },
    },
  ];
}
