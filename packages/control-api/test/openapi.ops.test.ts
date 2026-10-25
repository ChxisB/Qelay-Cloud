import { afterAll, beforeAll, expect, test } from 'bun:test';
import { describeDb } from '../../../test/support/db';
import { claimOne } from '../../store-postgres/test/finishHelpers';
import type { JobsApi, JobsFixture } from './jobsFixture';
import { openJobsFixture } from './jobsFixture';
import { keysFit } from './openapiSpec';

// The same pin as `openapi.jobs.test.ts`, for the bodies the DLQ, cron, worker, metrics and audit routes serve.
describeDb('docs/openapi.yaml operator bodies', () => {
  let f: JobsFixture;
  let api: JobsApi;

  beforeAll(async () => {
    f = await openJobsFixture();
    await f.reset();
    api = f.api({ summaryCacheMs: 0 });
    const job = await claimOne(f.t, { attempts: 1 }, 'q', 'w');
    await f.store.fail(job.lease, { message: 'boom', unrecoverable: true });
    await f.store.workers.register({
      id: 'w-1',
      queues: ['q'],
      name: 'main',
      hostname: 'h',
      pid: 1,
    });
    await api.call('POST', '/crons', { name: 'tick', queue: 'q', repeatEvery: 60_000 });
  }, 60_000);
  afterAll(() => f.drop());

  const fits = async (name: string, method: string, path: string, body?: unknown) => {
    const answer = await api.call(method, path, body);
    expect(answer.status, `${method} ${path}: ${JSON.stringify(answer.body)}`).toBeLessThan(300);
    expect(keysFit(answer.body, name), `${method} ${path}`).toEqual([]);
    return answer.body as Record<string, any>;
  };

  test('the DLQ routes document their list, statistics and purge', async () => {
    const list = await fits('DlqList', 'GET', '/queues/q/dlq');
    expect(list.entries.length).toBe(1);
    for (const entry of list.entries) expect(keysFit(entry, 'DlqEntry')).toEqual([]);
    const stats = await fits('DlqStatsResponse', 'GET', '/queues/q/dlq/stats');
    expect(keysFit(stats.stats, 'DlqStats')).toEqual([]);
    await fits('ActionCount', 'POST', '/queues/q/dlq/purge', { confirm: 'q' });
  });

  test('the queue settings document the stall and DLQ configuration', async () => {
    const stall = await fits('StallConfigResponse', 'GET', '/queues/q/stall-config');
    expect(keysFit(stall.config, 'StallConfig')).toEqual([]);
    await fits('StallConfigResponse', 'PUT', '/queues/q/stall-config', { maxStalls: 4 });
    const dlq = await fits('DlqConfigResponse', 'GET', '/queues/q/dlq-config');
    expect(keysFit(dlq.config, 'DlqConfig')).toEqual([]);
    // Retention is not changed through the API (501), so the settings are saved as they are.
    await fits('DlqConfigResponse', 'PUT', '/queues/q/dlq-config', dlq.config);
  });

  test('the cron routes document a cron as saved, listed and read', async () => {
    const list = await fits('CronList', 'GET', '/crons');
    expect(list.crons.length).toBe(1);
    for (const cron of list.crons) expect(keysFit(cron, 'Cron')).toEqual([]);
    const saved = await fits('CronEnvelope', 'PUT', '/crons/tick', {
      queue: 'q',
      repeatEvery: 30_000,
    });
    expect(keysFit(saved.cron, 'Cron')).toEqual([]);
    await fits('CronEnvelope', 'GET', '/crons/tick');
    await fits('Ok', 'DELETE', '/crons/tick');
  });

  test('the worker routes document the registry and a removal', async () => {
    const list = await fits('WorkersList', 'GET', '/workers');
    expect(list.data.workers.length).toBe(1);
    for (const worker of list.data.workers) expect(keysFit(worker, 'Worker')).toEqual([]);
    await fits('WorkerRemoved', 'DELETE', '/workers/w-1');
  });

  test('the transport and deployment routes document their bodies', async () => {
    const transport = await fits('TransportResponse', 'GET', '/transport');
    expect(transport.queues.length).toBeGreaterThan(0);
    for (const queue of transport.queues) {
      expect(keysFit(queue, 'TransportQueueStats')).toEqual([]);
      expect(keysFit(queue.freshness, 'Freshness')).toEqual([]);
      expect(keysFit(queue.store, 'DoorbellHealthRow')).toEqual([]);
    }
    await fits('DeadLettersResponse', 'GET', '/transport/dead-letters?queue=q');
    const deployment = await fits('DeploymentResponse', 'GET', '/deployment');
    for (const warning of deployment.warnings) {
      expect(keysFit(warning, 'DeploymentWarning')).toEqual([]);
    }
    for (const part of ['schema', 'database', 'connections', 'tick', 'workers', 'doorbells']) {
      expect(deployment[part], part).toBeDefined();
    }
  });

  test('the backup policy documents its envelope while undeclared and once declared', async () => {
    const undeclared = await fits('BackupPolicyEnvelope', 'GET', '/backup-policy');
    expect(undeclared.data.policy).toBeNull();
    const body = { mechanism: 'external', tool: 'pgBackRest', location: 'gs://acme-backups' };
    const saved = await fits('BackupPolicySetEnvelope', 'PUT', '/backup-policy', body);
    expect(keysFit(saved.data.policy, 'BackupPolicy')).toEqual([]);
    const declared = await fits('BackupPolicyEnvelope', 'GET', '/backup-policy');
    expect(keysFit(declared.data.policy, 'BackupPolicy')).toEqual([]);
  });

  test('the metrics, status and audit routes document their bodies', async () => {
    await fits('MetricsTotals', 'GET', '/metrics');
    const series = await fits('MetricsSeries', 'GET', '/metrics/queues/q?minutes=3');
    for (const point of series.points) expect(keysFit(point, 'MetricsPoint')).toEqual([]);
    await fits('Ping', 'GET', '/ping');
    await fits('StorageStatus', 'GET', '/storage');
    const audit = await fits('AuditLog', 'GET', '/audit');
    expect(audit.entries.length).toBeGreaterThan(0);
    for (const entry of audit.entries) expect(keysFit(entry, 'AuditEntry')).toEqual([]);
  });
});
