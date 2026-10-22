import { describe, expect, test } from 'bun:test';
import { homeIssues, RANK } from '../src/pages/control/home/model';
import { EMPTY_OVERVIEW, type OverviewSnapshot } from '../src/pages/control/overview/model';
import { route } from './gateway.helpers';
import { deployment, queue, transport } from './ops.helpers';

const snapshot = (over: Partial<OverviewSnapshot> = {}): OverviewSnapshot => ({
  ...EMPTY_OVERVIEW,
  ...over,
});

const steady = () => deployment({ workers: { total: 3, active: 3 } });
const none = { snapshot: snapshot(), deployment: null, transport: null, routes: [], breaches: [] };
const breach = (ruleName: string) => ({
  ruleId: ruleName,
  ruleName,
  metricLabel: 'Waiting',
  operator: '>' as const,
  threshold: 10,
  value: 20,
  queue: 'orders',
  at: 1,
});
const withStats = (dlq: number): OverviewSnapshot => {
  const base = snapshot();
  return { ...base, overview: { ...base.overview, stats: { ...base.overview.stats, dlq } } };
};

describe('Home issues', () => {
  test('a healthy deployment has none', () => {
    expect(
      homeIssues({
        ...none,
        deployment: steady(),
        transport: transport([queue('orders')]),
        routes: [route() as never],
      })
    ).toEqual([]);
  });

  test('a source that could not be read adds nothing and hides nothing else', () => {
    const issues = homeIssues({ ...none, snapshot: snapshot({ pausedQueues: ['orders'] }) });
    expect(issues.map((i) => i.id)).toEqual(['paused-queues']);
  });

  test('every open problem is listed, worst first', () => {
    const issues = homeIssues({
      snapshot: { ...withStats(2), pausedQueues: ['a', 'b'], failedTotal: 4, readyTotal: 500 },
      deployment: deployment({
        workers: { total: 5, active: 3 },
        warnings: [
          { code: 'devToken', severity: 'warning', message: 'A dev token is set.' },
          { code: 'schema', severity: 'critical', message: 'The schema is behind.' },
        ],
      }),
      transport: transport([queue('orders', { deadLetterDepth: 3 })]),
      routes: [
        route({
          id: 'a',
          enabled: false,
          pausedBy: 'failures',
          disabledReason: '10 failures in a row',
        }) as never,
        route({ id: 'b', consecutiveFailures: 7, alertLevel: 2 }) as never,
      ],
      breaches: [breach('Backlog high')],
    });
    expect(issues.map((i) => i.id)).toEqual([
      'warning:schema',
      'alerts',
      'dead-letters',
      'route-paused',
      'quiet-workers',
      'paused-queues',
      'backlog',
      'route-failing',
      'poison-doorbells',
      'warning:devToken',
    ]);
    expect(issues.map((i) => i.rank)).toEqual([...issues.map((i) => i.rank)].sort((a, b) => a - b));
    expect(RANK.critical).toBeLessThan(RANK.warning);
  });

  test('failed jobs show only when nothing is dead-lettered, as on Overview', () => {
    expect(homeIssues({ ...none, snapshot: snapshot({ failedTotal: 3 }) })[0]?.id).toBe(
      'failed-jobs'
    );
    expect(
      homeIssues({ ...none, snapshot: { ...withStats(1), failedTotal: 3 } }).map((i) => i.id)
    ).toEqual(['dead-letters']);
  });

  test('a lone paused connection is named, several are counted', () => {
    const one = homeIssues({
      ...none,
      routes: [route({ enabled: false, pausedBy: 'failures', disabledReason: 'x' }) as never],
    });
    expect(one[0]?.headline).toContain('emails');
    const two = homeIssues({
      ...none,
      routes: [
        route({ id: 'a', enabled: false, pausedBy: 'failures', disabledReason: 'x' }) as never,
        route({ id: 'b', enabled: false, pausedBy: 'failures', disabledReason: 'x' }) as never,
      ],
    });
    expect(two[0]?.headline).toBe('2 gateway connections were paused after failures');
  });

  test('a late maintenance run is read from the deployment answer', () => {
    const behind = transport([
      queue('orders', { store: { notRung: 5, oldestNotRungAgeMs: 120_000 } }),
    ]);
    expect(
      homeIssues({ ...none, deployment: steady(), transport: behind }).map((i) => i.id)
    ).toEqual(['doorbells-behind']);
    // Younger than the deployment's own "late" line: waiting its turn, not a problem.
    const young = transport([
      queue('orders', { store: { notRung: 5, oldestNotRungAgeMs: 1_000 } }),
    ]);
    expect(homeIssues({ ...none, deployment: steady(), transport: young })).toEqual([]);
  });
});
