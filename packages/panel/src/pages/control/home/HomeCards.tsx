import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { StatCard, type StatTone } from '@/components/ui/StatCard';
import { type StateRole, StatusGlyph } from '@/components/ui/StatusBadge';
import { formatNumber, formatPercent } from '@/lib/format';
import { doorbellVerdict, figure, stripTone } from '@/lib/ops/health';
import { stagger } from '@/lib/stagger';
import { routeIssues } from '../gateway/model';
import type { OverviewSnapshot } from '../overview/model';
import type { useHomeFeeds } from './useHomeFeeds';

type Feeds = ReturnType<typeof useHomeFeeds>;

interface Card {
  id: string;
  label: string;
  to: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: StatTone;
}

const UNAVAILABLE = { value: '—', hint: 'Unavailable', tone: 'waiting' } as const;

/** A card whose call failed (and has nothing older to show) says so in its own place. */
const failed = (feed: { data: unknown; error: unknown }) => !feed.data && !!feed.error;

/** A tone that means something gets its glyph beside the hint, so colour is never the only signal. */
const GLYPH: Partial<Record<StatTone, StateRole>> = {
  green: 'completed',
  amber: 'delayed',
  red: 'failed',
  waiting: 'waiting',
  active: 'active',
};

/** One headline figure per area, each a link to the page that has the detail. */
export function buildCards(snapshot: OverviewSnapshot, feeds: Feeds): Card[] {
  const { deployment, transport, gateway, gatewayOpen, breaches, isPageAvailable } = feeds;
  const stats = snapshot.overview.stats;
  const cards: Card[] = [
    {
      id: 'queues',
      label: 'Queues',
      to: '/queues',
      value: formatNumber(snapshot.queuesTotal),
      hint:
        snapshot.pausedQueues.length > 0 ? `${snapshot.pausedQueues.length} paused` : 'none paused',
      tone: snapshot.pausedQueues.length > 0 ? 'amber' : 'default',
    },
    {
      id: 'jobs',
      label: 'Jobs',
      to: '/jobs',
      value: formatNumber(snapshot.readyTotal),
      hint: `ready · ${formatNumber(stats.active)} running · ${formatNumber(snapshot.failedTotal)} failed`,
      tone: snapshot.failedTotal > 0 ? 'amber' : 'default',
    },
  ];
  if (isPageAvailable('/dlq')) {
    cards.push({
      id: 'dlq',
      label: 'Dead letter queue',
      to: '/dlq',
      value: formatNumber(stats.dlq),
      hint: stats.dlq > 0 ? 'waiting for a decision' : 'empty',
      tone: stats.dlq > 0 ? 'red' : 'green',
    });
  }

  const d = deployment.data;
  const workers = d?.workers;
  const quiet =
    workers && workers.total !== null && workers.active !== null
      ? workers.total - workers.active
      : 0;
  cards.push({
    id: 'workers',
    label: 'Workers',
    to: '/workers',
    ...(failed(deployment) || !workers
      ? UNAVAILABLE
      : {
          value: `${figure(workers.active)} of ${figure(workers.total)}`,
          hint: quiet > 0 ? `${quiet} gone quiet` : 'all reporting',
          tone: quiet > 0 ? ('amber' as const) : ('default' as const),
        }),
  });

  if (isPageAvailable('/cron')) {
    cards.push({
      id: 'cron',
      label: 'Cron jobs',
      to: '/cron',
      value: formatNumber(snapshot.overview.crons.total),
      hint: 'scheduled',
    });
  }

  if (gatewayOpen) {
    const feed = gateway.data;
    const flagged = feed ? routeIssues(feed.routes) : [];
    const day = feed?.stats;
    cards.push({
      id: 'gateway',
      label: 'Event gateway',
      to: '/events-gateway/metrics',
      ...(failed(gateway) || !feed
        ? UNAVAILABLE
        : {
            value: typeof day?.failureRatio === 'number' ? formatPercent(day.failureRatio) : '—',
            hint: day
              ? `failed, last 24h · ${formatNumber(day.delivered)} delivered · ${formatNumber(day.failed)} failed`
              : 'last 24h unavailable',
            tone: flagged.some((issue) => issue.kind === 'paused')
              ? ('red' as const)
              : flagged.length > 0 || (day?.failed ?? 0) > 0
                ? ('amber' as const)
                : ('default' as const),
          }),
    });
  }

  const t = transport.data;
  const verdicts = t
    ? t.queues.map((q) => doorbellVerdict(q, d?.tick.lateAfterMs ?? 60_000).kind)
    : [];
  cards.push({
    id: 'delivery',
    label: 'Job delivery',
    to: '/transport',
    ...(failed(transport) && failed(deployment)
      ? UNAVAILABLE
      : {
          value: d?.doorbells
            ? `${figure(d.doorbells.notRung)}${d.doorbells.partial ? '+' : ''}`
            : '—',
          hint: verdicts.includes('poison')
            ? 'failed notifications to workers'
            : verdicts.includes('tick-behind')
              ? 'maintenance is behind'
              : 'jobs not yet told to workers',
          tone: verdicts.includes('poison')
            ? ('red' as const)
            : verdicts.includes('tick-behind')
              ? ('amber' as const)
              : ('default' as const),
        }),
  });

  const tone = d ? stripTone(d) : 'zinc';
  cards.push({
    id: 'health',
    label: 'Health',
    to: '/deployment',
    ...(failed(deployment) || !d
      ? UNAVAILABLE
      : {
          value:
            d.warnings.length === 0
              ? 'OK'
              : `${d.warnings.length} warning${d.warnings.length === 1 ? '' : 's'}`,
          hint: `database ${d.database.state} · transport ${d.transport.state}`,
          tone:
            tone === 'red'
              ? ('red' as const)
              : tone === 'amber' || d.warnings.length > 0
                ? ('amber' as const)
                : ('green' as const),
        }),
  });

  cards.push({
    id: 'alerts',
    label: 'Alerts',
    to: '/alerts',
    value: formatNumber(breaches.length),
    hint: breaches.length > 0 ? 'firing now' : 'none firing in this browser',
    tone: breaches.length > 0 ? 'red' : 'default',
  });
  return cards;
}

export function HomeCards({ cards }: { cards: readonly Card[] }) {
  return (
    <section aria-label="Numbers" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {cards.map((card, index) => {
        const glyph = card.tone && GLYPH[card.tone];
        return (
          <Link
            key={card.id}
            to={card.to}
            data-testid={`home-card-${card.id}`}
            style={stagger(index)}
            className="motion-arrive block rounded-card no-underline hover:opacity-90 focus-visible:outline-2"
          >
            <StatCard
              label={card.label}
              value={card.value}
              hint={
                glyph && card.hint ? (
                  <span className="inline-flex items-center gap-1.5">
                    <StatusGlyph state={glyph} small />
                    {card.hint}
                  </span>
                ) : (
                  card.hint
                )
              }
              tone={card.tone}
            />
          </Link>
        );
      })}
    </section>
  );
}
