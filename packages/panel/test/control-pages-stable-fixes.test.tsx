import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { useConnectionStore } from '../src/components/dashboard/stores/connectionStore';
import type { QueueOperationsRepository } from '../src/features/queue-operations/application/QueueOperationsRepository';
import { QueueOperationsPanel } from '../src/features/queue-operations/ui/QueueOperationsPanel';
import type { ServerTargetClient } from '../src/lib/bq';
import { createBenchmarkCompensationQueue } from '../src/pages/control/benchmark/compensationQueue';
import { DEFAULT_CONFIG } from '../src/pages/control/benchmark/engine';
import { type BenchmarkLoopContext, createConsumer } from '../src/pages/control/benchmark/runLoops';
import { freshBenchmarkStats } from '../src/pages/control/benchmark/runtimeState';
import { validateBulkItems } from '../src/pages/control/bulkAdd/validation';
import { LimitsCards } from '../src/pages/control/queue/LimitsCards';
import { rateLimitArgs } from '../src/pages/control/queue/queueActionModel';
import { Webhooks } from '../src/pages/control/Webhooks';
import {
  button,
  byName,
  change,
  click,
  deferred,
  json,
  render,
  settle,
  installStableFixHooks,
} from './control-pages-stable-fixes.helpers';
import { repositoryOf } from './queue-operations-ui.repository';

// Regression tests for stable control-page fixes (items 1-5). Each fails
// against the pre-fix implementation.

const realFetch = globalThis.fetch;
const realConfirm = window.confirm;

installStableFixHooks();

beforeEach(() => {
  useConnectionStore.setState({
    baseUrl: 'http://server-a.test',
    agentBaseUrl: 'http://agent-a.test',
    token: '',
    agentToken: '',
    refreshMs: 60_000,
  });
  window.confirm = () => true;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  window.confirm = realConfirm;
});

describe('benchmark count-mode drain with several workers', () => {
  test('an idle worker waits for a sibling still ACKing instead of reporting undrained jobs', async () => {
    const heartbeat = deferred<{ ok: boolean; data: { ok: boolean; count: number } }>();
    const jobs = [{ id: 'job-1' }, { id: 'job-2' }];
    let pulls = 0;
    const client = {
      pullBatch: async () => {
        pulls += 1;
        return pulls === 1
          ? { ok: true, jobs, tokens: ['lock-1', 'lock-2'] }
          : { ok: true, jobs: [], tokens: [] };
      },
      heartbeatBatch: () => heartbeat.promise,
      ackBatch: async () => ({ ok: true }),
      retryJob: async () => ({ ok: true }),
    } as unknown as ServerTargetClient;
    const stats = freshBenchmarkStats();
    let running = true;
    const context: BenchmarkLoopContext = {
      batch: 2,
      blob: '',
      client,
      compensationQueue: createBenchmarkCompensationQueue(),
      deadline: Number.POSITIVE_INFINITY,
      isCurrent: () => true,
      ownJobIds: new Set(['job-1', 'job-2']),
      payload: 0,
      pendingPushes: new Set(),
      processMs: 0,
      producersDone: () => true,
      queue: 'benchmark',
      runId: 'run-1',
      runConfig: { ...DEFAULT_CONFIG, total: 2, workers: 2, workerBatch: 2 },
      shouldContinue: () => running,
      stats,
      stop: () => {
        running = false;
      },
      total: 2,
      workerBatch: 2,
    };

    const consumers = Array.from({ length: 2 }, createConsumer(context));
    const deadline = performance.now() + 1_000;
    while (pulls < 2 && performance.now() < deadline) await Bun.sleep(1);
    // The second worker's pull came back empty while the first still holds
    // both jobs mid-heartbeat.
    await Bun.sleep(10);
    expect(stats.error).toBeNull();
    heartbeat.resolve({ ok: true, data: { ok: true, count: 2 } });
    await Promise.all(consumers);

    expect(stats.completed).toBe(2);
    expect(context.ownJobIds.size).toBe(0);
    expect(stats.error).toBeNull();
  });
});

describe('webhook toggle lease', () => {
  test('navigating away mid-toggle releases the lock for the remounted page', async () => {
    const firstToggle = deferred<Response>();
    let toggles = 0;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.endsWith('/webhooks') && method === 'GET') {
        return Promise.resolve(
          json({
            ok: true,
            data: {
              webhooks: [
                {
                  id: 'hook-1',
                  url: 'https://example.test/hook',
                  urlRedacted: false,
                  signed: false,
                  events: ['job.completed'],
                  enabled: false,
                  successCount: 0,
                  failureCount: 0,
                  lastTriggered: null,
                  queue: null,
                  createdAt: 1_000,
                },
              ],
            },
          })
        );
      }
      if (url.endsWith('/webhooks/hook-1/enabled') && method === 'PUT') {
        toggles += 1;
        return toggles === 1 ? firstToggle.promise : Promise.resolve(json({ ok: true }));
      }
      return Promise.resolve(json({ ok: false, error: `Unexpected ${method} ${url}` }, 500));
    }) as typeof fetch;

    const first = render(createElement(Webhooks));
    await settle(20);
    click(first.host.querySelector('button[role="switch"]') as HTMLButtonElement);
    expect(toggles).toBe(1);
    first.unmount();
    firstToggle.resolve(json({ ok: true }));
    await settle(10);

    const second = render(createElement(Webhooks));
    await settle(20);
    click(second.host.querySelector('button[role="switch"]') as HTMLButtonElement);
    await settle(10);
    expect(toggles).toBe(2);
  });
});

describe('bulk add spec-mode job name', () => {
  test.each([
    ['empty string', ''],
    ['blank string', '   '],
    ['object', {}],
    ['array', []],
    ['boolean', true],
    ['over 256 characters', 'n'.repeat(257)],
  ])('rejects an invalid name (%s) instead of routing to the default handler', (_label, name) => {
    const result = validateBulkItems([{ name, data: {} }], {}, 'spec');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.msg).toContain('Job 1: name must be');
  });

  test('keeps a valid string or numeric name', () => {
    const result = validateBulkItems(
      [
        { name: 'send-email', data: {} },
        { name: 42, data: {} },
      ],
      {},
      'spec'
    );
    expect(result.ok && result.bodies.map((body) => body.name)).toEqual(['send-email', '42']);
  });
});

describe('blank numeric fields on destructive actions', () => {
  test('a cleared journal retention disables Trim instead of trimming to 0', async () => {
    const calls: string[] = [];
    const repository: QueueOperationsRepository = repositoryOf(calls);
    const view = render(
      createElement(
        MemoryRouter,
        null,
        createElement(QueueOperationsPanel, { queue: 'orders', repository })
      )
    );
    await settle(10);
    change(byName(view.host, 'queue-sdk-event-retention'), '');
    expect(button(view.host, 'Trim journal').disabled).toBe(true);
    click(button(view.host, 'Trim journal'));
    await settle(5);
    expect(calls.some((call) => call.startsWith('trim:'))).toBe(false);
  });
});

describe('rate limit "Expires after" mode', () => {
  test('rateLimitArgs requires a TTL when the policy expires', () => {
    expect(rateLimitArgs('10', '1000', '', true).valid).toBe(false);
    expect(rateLimitArgs('10', '1000', '500', true)).toEqual({
      limit: 10,
      duration: 1000,
      ttl: 500,
      valid: true,
    });
    expect(rateLimitArgs('10', '1000', '').valid).toBe(true);
  });

  test('a blank TTL is not sent as a permanent policy', () => {
    const runs: string[] = [];
    const view = render(
      createElement(LimitsCards, {
        queue: 'orders',
        busy: false,
        run: (label: string) => {
          runs.push(label);
        },
      })
    );
    change(byName(view.host, 'rate-limit'), '10');
    change(byName(view.host, 'rate-duration'), '1000');
    change(byName(view.host, 'rate-ttl-mode'), 'expires');
    const replace = button(view.host, 'Replace policy');
    expect(replace.disabled).toBe(true);
    expect(view.host.textContent).toContain('Limit, window and TTL are required');
    click(replace);
    expect(runs).toEqual([]);

    change(byName(view.host, 'rate-ttl'), '500');
    expect(button(view.host, 'Replace policy').disabled).toBe(false);
  });
});
