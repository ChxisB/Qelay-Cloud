import type { ReactNode } from 'react';
import { ICON } from '@/components/layout/NavIcon';
import { Card, CardHeader } from '@/components/ui/Card';
import { CopyButton } from '@/components/ui/CopyButton';
import { LinkButton } from '@/components/ui/LinkButton';
import { Tag } from '@/components/ui/Tag';
import type { WebhookFull } from '@/lib/bqTypes';
import { formatDateTime, formatRelativeTime } from '@/lib/format';
import { useRises } from '@/lib/useChangeFlash';
import { ConnectionChain } from './ConnectionChain';
import { Figure } from './ConnectionFigures';
import { ruleCards } from './connectionRules';
import { EventsChart, StatCards, StatsFrame } from './MetricsParts';
import {
  destinationLabel,
  destinationSub,
  eventsLink,
  type RouteState,
  ruleChips,
  sourceLabel,
} from './model';
import { DEFAULT_RANGE, useGatewayStats } from './useGatewayStats';

const Row = ({ label, children }: { label: string; children: ReactNode }) => (
  <div className="py-2.5">
    <dt className="text-[13px] text-muted">{label}</dt>
    <dd className="mt-0.5 min-w-0 break-words text-sm text-fg">{children}</dd>
  </div>
);

/** The line of the connection on top; what it is, on the left; its last 24 hours, on the right. */
export function ConnectionOverview({ route, state }: { route: WebhookFull; state: RouteState }) {
  const result = useGatewayStats(route.id, DEFAULT_RANGE);
  const chips = ruleChips(route);
  // The comet follows a total that went up between two reads, so it means events really arrived.
  const pulse = useRises(route.successCount);
  const queue = route.destination === 'queue';
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader title="The line of this connection" headingLevel={3} />
        <ConnectionChain
          source={{ kind: 'source', icon: ICON.queues, name: sourceLabel(route), sub: 'Source' }}
          destination={{
            kind: queue ? 'queue' : 'http',
            icon: queue ? ICON.queues : ICON.webhooks,
            name: destinationLabel(route),
            sub: destinationSub(route),
          }}
          stations={ruleCards(route)
            .filter((rule) => rule.editable && rule.on)
            .map((rule) => ({ name: rule.name, word: 'On' }))}
          state={state}
          pulse={pulse}
        />
      </Card>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[20rem_minmax(0,1fr)]">
        <Card>
          <CardHeader title="Details" headingLevel={3} />
          <dl className="divide-y divide-line">
            <Row label="Source">{sourceLabel(route)}</Row>
            <Row label="Destination">
              <span className="font-mono text-[13px]">{destinationLabel(route)}</span>
              <span className="block text-[13px] text-muted">
                {route.destination === 'queue'
                  ? 'adds a job to that queue'
                  : `${route.signed ? 'signed' : 'unsigned'}${route.urlRedacted ? ' · path hidden' : ''}`}
              </span>
            </Row>
            <Row label="Rules">
              {chips.length === 0 ? (
                <span className="text-muted">None: every matching event is sent</span>
              ) : (
                <span className="flex flex-wrap gap-1.5">
                  {chips.map((chip) => (
                    <Tag key={chip}>{chip}</Tag>
                  ))}
                </span>
              )}
            </Row>
            <Row label="Sent so far">
              <Figure value={route.successCount} word="successful" /> ·{' '}
              <Figure value={route.failureCount} word="failed" bad />
            </Row>
            <Row label="Last triggered">{formatRelativeTime(route.lastTriggered)}</Row>
            <Row label="Created">{formatDateTime(route.createdAt)}</Row>
            <Row label="Id">
              <span className="inline-flex items-center gap-1.5 font-mono text-[13px]">
                {route.id}
                <CopyButton value={route.id} />
              </span>
            </Row>
          </dl>
        </Card>
        <div className="flex min-w-0 flex-col gap-4">
          <StatsFrame result={result}>
            {(stats) => (
              <>
                <StatCards stats={stats} />
                <EventsChart stats={stats} range={DEFAULT_RANGE} />
              </>
            )}
          </StatsFrame>
          <div className="flex flex-wrap gap-2">
            <LinkButton size="sm" to={`${eventsLink({ route: route.id })}`}>
              View events
            </LinkButton>
          </div>
        </div>
      </div>
    </div>
  );
}
