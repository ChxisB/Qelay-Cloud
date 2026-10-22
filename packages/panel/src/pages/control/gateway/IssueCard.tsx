import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { LinkButton } from '@/components/ui/LinkButton';
import { ConnectionLine } from '@/components/ui/nodegraph/ConnectionLine';
import { ConnectionGlyph, type ConnectionState } from '@/components/ui/nodegraph/connectionState';
import { Tag } from '@/components/ui/Tag';
import type { WebhookIssueFull, WebhookIssueStatus } from '@/lib/bq';
import type { WebhookFull } from '@/lib/bqTypes';
import { formatRelativeTime } from '@/lib/format';
import { stagger } from '@/lib/stagger';
import { connectionLink, destinationLabel, eventsLink, routeName, sourceLabel } from './model';

export const STATUS_WORDS: Record<WebhookIssueStatus, string> = {
  open: 'Open',
  acknowledged: 'Acknowledged',
  resolved: 'Resolved',
  ignored: 'Ignored',
};

/** What an operator can do to an issue in each status. A resolved one is history: the next failure opens a new one. */
const ACTIONS: Record<WebhookIssueStatus, ReadonlyArray<[WebhookIssueStatus, string]>> = {
  open: [
    ['acknowledged', 'Acknowledge'],
    ['ignored', 'Ignore'],
    ['resolved', 'Resolve'],
  ],
  acknowledged: [
    ['ignored', 'Ignore'],
    ['resolved', 'Resolve'],
    ['open', 'Reopen'],
  ],
  ignored: [
    ['open', 'Reopen'],
    ['resolved', 'Resolve'],
  ],
  resolved: [],
};

/** The words an issue is known by: what the connection is doing now while it is live, that it recovered once it is not. */
function titleOf(issue: WebhookIssueFull): string {
  if (issue.status === 'resolved') return 'Recovered';
  if (issue.pausedBy === 'failures') return 'Paused after failures';
  return issue.consecutiveFailures > 0
    ? `${issue.consecutiveFailures} events failed in a row`
    : 'Deliveries failed';
}

/**
 * The line the issue is about, with the word that says how it stands: dashed when the connection stopped itself,
 * solid red while it still tries, solid green once it recovered. The ends are real text in reading order.
 */
function IssueLine({ issue, route }: { issue: WebhookIssueFull; route: WebhookFull }) {
  const recovered = issue.status === 'resolved';
  const stopped = !recovered && issue.pausedBy === 'failures';
  const state: ConnectionState = stopped ? 'paused' : 'active';
  const tone = recovered ? 'text-success' : stopped ? undefined : 'text-danger';
  return (
    <div className="mt-3 grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-4 text-[13px]">
      <span className="min-w-0 break-words text-right font-mono text-muted">
        {sourceLabel(route)}
      </span>
      <ConnectionLine state={state} tone={tone}>
        <span className="inline-flex items-center gap-1.5 bg-surface px-2 text-xs font-bold text-fg">
          <ConnectionGlyph state={state} />
          {recovered ? 'Recovered' : stopped ? 'Stopped itself' : 'Still trying'}
        </span>
      </ConnectionLine>
      <span className="min-w-0 break-words font-mono text-muted">{destinationLabel(route)}</span>
    </div>
  );
}

/**
 * One issue: which connection, how it stands, and what can be done. `route` is null when the connections have
 * not loaded, or the connection was removed in the meantime. A viewer reads it; an operator can move it to another status or resume a paused connection.
 */
export function IssueCard({
  issue,
  route,
  canOperate,
  busy,
  arrive,
  onSet,
  onResume,
}: {
  issue: WebhookIssueFull;
  route: WebhookFull | null;
  canOperate: boolean;
  busy: boolean;
  /** Where the card rises as it mounts (`useRowArrivals`), read once; undefined for a card that is just there. */
  arrive?: number;
  onSet: (status: WebhookIssueStatus) => void;
  onResume: () => void;
}) {
  const [place] = useState(arrive);
  const resumable = route !== null && !route.enabled && issue.pausedBy === 'failures';
  const changed =
    issue.status === 'open'
      ? ''
      : ` ${STATUS_WORDS[issue.status]} ${formatRelativeTime(issue.updatedAt)}.`;
  const by = changed !== '' && issue.updatedBy ? ` By ${issue.updatedBy}.` : '';
  return (
    <li
      className={place === undefined ? undefined : 'motion-arrive'}
      style={place === undefined ? undefined : stagger(place)}
    >
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="m-0 flex flex-wrap items-center gap-2 text-[13px] font-bold text-danger">
              {titleOf(issue)}
              <Tag>{STATUS_WORDS[issue.status]}</Tag>
            </p>
            <p className="m-0 mt-1 break-words text-[13px] font-bold text-fg">
              {route ? routeName(route) : (issue.webhookName ?? issue.webhookId)}
            </p>
            <p className="m-0 mt-1 text-[13px] text-muted">
              Opened {formatRelativeTime(issue.openedAt)}.{changed}
              {by}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {route && (
              <>
                <LinkButton size="sm" to={eventsLink({ route: route.id, status: 'failed' })}>
                  View failed events
                </LinkButton>
                <LinkButton size="sm" to={connectionLink(route.id)}>
                  Open connection
                </LinkButton>
              </>
            )}
            {canOperate && resumable && (
              <Button size="sm" variant="primary" disabled={busy} onClick={onResume}>
                Resume connection
              </Button>
            )}
            {canOperate &&
              ACTIONS[issue.status].map(([status, label]) => (
                <Button key={status} size="sm" disabled={busy} onClick={() => onSet(status)}>
                  {label}
                </Button>
              ))}
          </div>
        </div>
        {route && <IssueLine issue={issue} route={route} />}
      </Card>
    </li>
  );
}
