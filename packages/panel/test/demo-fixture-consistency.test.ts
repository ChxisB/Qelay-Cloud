import { describe, expect, test } from 'bun:test';

import { demoStatus, demoWorkers } from '../src/lib/demo/control';
import { DEMO_JOB_POOL } from '../src/lib/demo/jobs';
import { F } from '../src/lib/demo/shared';

// The public demo is what the live site and every docs screenshot show, so its numbers
// must agree with each other: a tab count that lists fewer rows than it claims, or a
// fact that reads "—", looks like a bug in the product.

type Summary = { name: string; counts: Record<string, number> };

describe('demo fixtures agree with themselves', () => {
  const summary = F.queuesSummary as unknown as Summary[];
  const emails = summary.find((queue) => queue.name === 'emails');
  const dlqTotal = (F.dlqStats as { total: number }).total;

  test('the Failed tab lists as many jobs as its count claims', () => {
    const listed = DEMO_JOB_POOL.filter((job) => job.state === 'failed');
    expect(emails?.counts.failed).toBe(listed.length);
    expect(new Set(listed.map((job) => job.id)).size).toBe(listed.length);
  });

  test("a failed job added from the dead-letter queue shows that entry's error", () => {
    const entries = (F.dlq_emails as { entries: { job: Json; error: string }[] }).entries;
    for (const { job, error } of entries.slice(1)) {
      const listed = DEMO_JOB_POOL.find((entry) => entry.id === job.id);
      expect(listed?.state).toBe('failed');
      expect(listed?.failedReason).toBe(error);
    }
  });

  test('failed jobs, dead-letter entries and the health total are the same number', () => {
    const entries = (F.dlq_emails as { entries: unknown[] }).entries;
    expect(entries).toHaveLength(dlqTotal);
    expect((F.health as { queues: { dlq: number } }).queues.dlq).toBe(dlqTotal);
    expect(emails?.counts.failed).toBe(dlqTotal);
  });

  test('the Server page has a storage mode and live connections to show', () => {
    expect(demoStatus().storageMode).toBe('sqlite');
    const { tcp, ws, sse } = (F.health as { connections: Record<string, number> }).connections;
    expect(tcp + ws + sse).toBeGreaterThan(0);
  });

  test('the worker stats total matches the workers listed', () => {
    const { workers, stats } = (demoWorkers() as { data: { workers: unknown[]; stats: Json } })
      .data;
    expect(stats.total).toBe(workers.length);
  });
});

type Json = Record<string, unknown>;
