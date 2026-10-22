import type { Breach } from '@/lib/alertEngineMetrics';
import type { WebhookFull } from '@/lib/bqTypes';
import { doorbellVerdict } from '@/lib/ops/health';
import type { DeploymentView, TransportView } from '@/lib/ops/types';
import { routeIssues, routeLine } from '../gateway/model';
import { attentionFor } from '../overview/attention';
import { type OverviewSnapshot, WAITING_AMBER_THRESHOLD } from '../overview/model';

/** One open problem, with the page that has the detail. */
export interface HomeIssue {
  id: string;
  /** Lower is worse; the list is sorted by it. */
  rank: number;
  headline: string;
  detail: string;
  label: string;
  to: string;
}

/** Worst first: a deployment that cannot be trusted, then jobs that stopped, then things that are only slow. */
export const RANK = {
  critical: 0,
  alerts: 1,
  deadLetters: 2,
  routePaused: 3,
  workers: 4,
  queues: 5,
  failedJobs: 6,
  routeFailing: 7,
  delivery: 8,
  warning: 9,
} as const;

/** Used when the deployment answer is missing, so a queue's doorbell verdict can still be read. */
const DEFAULT_LATE_AFTER_MS = 60_000;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export interface HomeSources {
  snapshot: OverviewSnapshot;
  deployment: DeploymentView | null;
  transport: TransportView | null;
  routes: readonly WebhookFull[];
  breaches: readonly Breach[];
}

function queueIssues(s: OverviewSnapshot): HomeIssue[] {
  const issues: HomeIssue[] = [];
  const banner = attentionFor(s);
  if (banner) {
    issues.push({
      id: s.overview.stats.dlq > 0 ? 'dead-letters' : 'failed-jobs',
      rank: s.overview.stats.dlq > 0 ? RANK.deadLetters : RANK.failedJobs,
      headline: banner.headline,
      detail: banner.detail,
      label: banner.reviewLabel,
      to: banner.reviewTo,
    });
  }
  if (s.pausedQueues.length > 0) {
    issues.push({
      id: 'paused-queues',
      rank: RANK.queues,
      headline:
        s.pausedQueues.length === 1
          ? `The ${s.pausedQueues[0]} queue is paused`
          : `${s.pausedQueues.length} queues are paused`,
      detail: 'A paused queue keeps its jobs, and no worker takes them until it is resumed.',
      label: 'Open queues',
      to: '/queues',
    });
  }
  if (s.readyTotal > WAITING_AMBER_THRESHOLD) {
    issues.push({
      id: 'backlog',
      rank: RANK.queues,
      headline: `${plural(s.readyTotal, 'job is', 'jobs are')} ready and waiting for a worker`,
      detail:
        'The backlog is above what one worker clears quickly. Check that workers are running.',
      label: 'Open queues',
      to: '/queues',
    });
  }
  return issues;
}

function deploymentIssues(d: DeploymentView): HomeIssue[] {
  const issues: HomeIssue[] = d.warnings.map((warning) => ({
    id: `warning:${warning.code}`,
    rank: warning.severity === 'critical' ? RANK.critical : RANK.warning,
    headline: warning.message,
    detail: `Reported by the deployment check (${warning.code}).`,
    label: 'Open Health',
    to: '/deployment',
  }));
  const { total, active } = d.workers;
  if (total !== null && active !== null && total > active) {
    issues.push({
      id: 'quiet-workers',
      rank: RANK.workers,
      headline: `${plural(total - active, 'worker has', 'workers have')} gone quiet`,
      detail: 'No heartbeat recently. Open Workers to see which.',
      label: 'Open workers',
      to: '/workers',
    });
  }
  return issues;
}

function deliveryIssues(t: TransportView, lateAfterMs: number): HomeIssue[] {
  const verdicts = t.queues.map((queue) => ({
    queue,
    kind: doorbellVerdict(queue, lateAfterMs).kind,
  }));
  const poison = verdicts.filter((row) => row.kind === 'poison');
  const behind = verdicts.filter((row) => row.kind === 'tick-behind');
  const issues: HomeIssue[] = [];
  if (poison.length > 0) {
    const total = poison.reduce((sum, row) => sum + (row.queue.deadLetterDepth ?? 0), 0);
    issues.push({
      id: 'poison-doorbells',
      rank: RANK.delivery,
      headline: `${plural(total, 'notification', 'notifications')} to workers failed in ${plural(poison.length, 'queue', 'queues')}`,
      detail: 'The queue service gave up delivering them. The jobs stay in the database.',
      label: 'Open Job delivery',
      to: '/transport',
    });
  }
  if (behind.length > 0) {
    issues.push({
      id: 'doorbells-behind',
      rank: RANK.delivery,
      headline: `Workers have not been told about ready jobs in ${plural(behind.length, 'queue', 'queues')}`,
      detail: 'Maintenance is behind.',
      label: 'Open Job delivery',
      to: '/transport',
    });
  }
  return issues;
}

function gatewayIssues(routes: readonly WebhookFull[]): HomeIssue[] {
  const issues: HomeIssue[] = [];
  for (const kind of ['paused', 'failing'] as const) {
    const found = routeIssues(routes).filter((issue) => issue.kind === kind);
    if (found.length === 0) continue;
    const [first] = found;
    const what = found.length === 1 ? routeLine(first!.route) : null;
    issues.push({
      id: `route-${kind}`,
      rank: kind === 'paused' ? RANK.routePaused : RANK.routeFailing,
      headline:
        kind === 'paused'
          ? what === null
            ? `${found.length} gateway connections were paused after failures`
            : `A gateway connection was paused after failures: ${what}`
          : what === null
            ? `${found.length} gateway connections keep failing`
            : `A gateway connection keeps failing: ${what}`,
      detail:
        kind === 'paused'
          ? 'Events for it are on hold until someone turns it back on.'
          : 'It is on its way to being paused. Open Issues to see how far.',
      label: 'Open Issues',
      to: '/events-gateway/issues',
    });
  }
  return issues;
}

function alertIssues(breaches: readonly Breach[]): HomeIssue[] {
  if (breaches.length === 0) return [];
  const names = [...new Set(breaches.map((b) => b.ruleName))].slice(0, 3).join(', ');
  return [
    {
      id: 'alerts',
      rank: RANK.alerts,
      headline: `${plural(breaches.length, 'alert is', 'alerts are')} firing`,
      detail: names,
      label: 'Open Alerts',
      to: '/alerts',
    },
  ];
}

/** Every open problem the sources show, worst first. A source that could not be read adds nothing. */
export function homeIssues(s: HomeSources): HomeIssue[] {
  return [
    ...queueIssues(s.snapshot),
    ...(s.deployment ? deploymentIssues(s.deployment) : []),
    ...(s.transport
      ? deliveryIssues(s.transport, s.deployment?.tick.lateAfterMs ?? DEFAULT_LATE_AFTER_MS)
      : []),
    ...gatewayIssues(s.routes),
    ...alertIssues(s.breaches),
  ].sort((a, b) => a.rank - b.rank);
}
