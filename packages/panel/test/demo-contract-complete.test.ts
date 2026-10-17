import { describe, expect, test } from 'bun:test';
import { demoBackupResponse } from '../src/lib/demo/backups';
import { DEMO_CONFIG, demoControlLogs, demoStatus, demoWorkers } from '../src/lib/demo/control';

describe('demo backup contract', () => {
  test('covers every supported status, list and mutation route', () => {
    expect(demoBackupResponse(['backup', 'status'], 'GET')).toMatchObject({
      ok: true,
      result: { data: { enabled: true, bucket: 'qelay-demo-backups' } },
    });
    const listed = demoBackupResponse(['backup', 'list'], 'GET') as Record<string, any>;
    expect(listed).toMatchObject({ ok: true, result: { success: true } });
    expect(listed.result.data).toHaveLength(2);
    expect(listed.result.data[0]).toMatchObject({ key: 'backups/qelay-2026-08-04.db' });
    expect(demoBackupResponse(['backup', 'configure'], 'POST')).toEqual({
      ok: true,
      result: { configured: true, enabled: true },
    });
    expect(demoBackupResponse(['backup', 'now'], 'POST')).toMatchObject({
      ok: true,
      result: { data: { key: 'backups/qelay-demo-now.db' } },
    });
    expect(demoBackupResponse(['backup', 'restore'], 'POST')).toMatchObject({
      ok: true,
      result: { success: true },
    });
  });

  test('rejects wrong methods and unknown operations', () => {
    expect(demoBackupResponse(['backup', 'status'], 'POST')).toEqual({
      ok: false,
      error: 'Demo backup route not found',
    });
    expect(demoBackupResponse(['backup', 'missing'], 'GET')).toEqual({
      ok: false,
      error: 'Demo backup route not found',
    });
  });
});

describe('demo control contract', () => {
  test('reports a coherent managed process and database snapshot', () => {
    const before = Date.now();
    const status = demoStatus() as Record<string, any>;
    expect(status).toMatchObject({
      status: 'running',
      healthy: true,
      version: '2.9.4',
      config: DEMO_CONFIG,
      runningConfig: DEMO_CONFIG,
      db: { exists: true, totalSize: 2_703_360 },
    });
    expect(status.startedAt).toBeLessThanOrEqual(before - 3_599_000);
    expect(status.db.mtimeMs).toBeLessThanOrEqual(Date.now());
  });

  test('serves active and stale workers plus ordered process log streams', () => {
    const workers = demoWorkers() as Record<string, any>;
    expect(workers.data.stats).toEqual({
      total: 3,
      active: 2,
      totalProcessed: 1683,
      totalFailed: 7,
      activeJobs: 2,
    });
    expect(workers.data.workers.map((worker: any) => worker.status)).toEqual([
      'active',
      'active',
      'stale',
    ]);
    const logs = demoControlLogs() as Record<string, any>;
    expect(logs.lines.map((line: any) => line.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(logs.lines.map((line: any) => line.stream)).toEqual([
      'sys',
      'stdout',
      'stdout',
      'stdout',
      'stdout',
    ]);
    expect(logs.lines[0].line).toContain('qelay@2.9.11');
  });
});
