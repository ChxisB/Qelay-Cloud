import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/feedback';
import { LinkButton } from '@/components/ui/LinkButton';
import type { WebhookFull } from '@/lib/bqTypes';
import { formatRelativeTime } from '@/lib/format';
import { destinationLabel, eventsLink, routeIssues, sourceLabel } from './model';
import type { Switched } from './useRouteActions';

/**
 * The list for a server that keeps no issues: each connection's own failure count, paused ones first, with no
 * status to move them through; an issue goes away when the connection recovers.
 */
export function DerivedIssues({
  routes,
  optimistic,
  onResume,
}: {
  routes: readonly WebhookFull[];
  optimistic: Record<string, Switched>;
  onResume: (id: string) => void;
}) {
  const issues = routeIssues(routes);
  if (issues.length === 0) {
    return (
      <EmptyState
        title="No issues"
        hint="Every connection is delivering. A connection shows up here when its events keep failing, and stays until it recovers."
      />
    );
  }
  return (
    <ul className="m-0 flex list-none flex-col gap-3 p-0">
      {issues.map(({ route, kind, title, detail }) => (
        <li key={route.id}>
          <Card>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="m-0 text-[13px] font-bold text-danger">{title}</p>
                <p className="m-0 mt-1 break-words font-mono text-[13px] text-fg">
                  {sourceLabel(route)} → {destinationLabel(route)}
                </p>
                <p className="m-0 mt-1 text-[13px] text-muted">
                  {detail}
                  {kind === 'paused' && route.disabledAt !== null
                    ? ` Paused ${formatRelativeTime(route.disabledAt)}.`
                    : ''}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <LinkButton size="sm" to={eventsLink({ route: route.id, status: 'failed' })}>
                  View failed events
                </LinkButton>
                {kind === 'paused' && (
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={optimistic[route.id]?.value === true}
                    onClick={() => onResume(route.id)}
                  >
                    Turn back on
                  </Button>
                )}
              </div>
            </div>
          </Card>
        </li>
      ))}
    </ul>
  );
}
