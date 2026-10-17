import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, createElement } from 'react';
import { useConnectionStore } from '../src/components/dashboard/stores/connectionStore';
import { BackupOperationsPanel } from '../src/features/backups/ui/BackupOperationsPanel';
import { parseInput } from '../src/pages/control/bulkAdd/input';
import { CronPrimaryFields } from '../src/pages/control/cron/CronPrimaryFields';
import type { CronFormValues } from '../src/pages/control/cron/model';
import {
  button,
  click,
  deferred,
  json,
  render,
  waitFor,
  installStableFixHooks,
} from './control-pages-stable-fixes.helpers';

// Regression tests for stable control-page fixes (items 7 and 12).

const realFetch = globalThis.fetch;
const realConfirm = window.confirm;
const realPrompt = window.prompt;

installStableFixHooks();

beforeEach(() => {
  useConnectionStore.setState({
    baseUrl: 'https://server-a.invalid/api',
    agentBaseUrl: 'http://agent-a.test',
    token: 'server-a-token',
    agentToken: 'agent-a-token',
    refreshMs: 3000,
  });
  window.confirm = () => true;
  window.prompt = () => 'RESTORE';
});

afterEach(() => {
  globalThis.fetch = realFetch;
  window.confirm = realConfirm;
  window.prompt = realPrompt;
});

const backupResult = (data: unknown) =>
  json({ ok: true, result: { success: true, message: 'ok', data } });
const backupStatus = () =>
  backupResult({
    enabled: true,
    bucket: 'production',
    endpoint: 'AWS S3',
    interval: '360 minutes',
    retention: '7 backups',
  });

describe('backup operation scope', () => {
  test('an agent-URL-only switch drops a restore queued against the previous agent', async () => {
    const requests: URL[] = [];
    let heldStatus: Promise<Response> | null = null;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      requests.push(url);
      if (url.pathname === '/backup/status') {
        const response = heldStatus ?? backupStatus();
        heldStatus = null;
        return response;
      }
      if (url.pathname === '/backup/list') {
        return backupResult([
          { key: 'backups/a.db', size: '1.00 MB', date: '2026-08-15T12:00:00.000Z' },
        ]);
      }
      if (url.pathname === '/control/status') {
        return json({
          status: 'stopped',
          db: {
            path: '/server-a/db.sqlite',
            exists: true,
            size: 100,
            walSize: 20,
            shmSize: 10,
            totalSize: 130,
            mtimeMs: 1234,
          },
        });
      }
      return json({ ok: true, result: { success: true, message: 'unexpected mutation' } });
    }) as typeof fetch;

    const view = render(createElement(BackupOperationsPanel, { pollIntervalMs: 60_000 }));
    await waitFor(() => view.host.textContent?.includes('backups/a.db') === true);
    const held = deferred<Response>();
    heldStatus = held.promise;
    const statusCalls = () => requests.filter((url) => url.pathname === '/backup/status').length;
    click(button(view.host, 'Refresh'));
    await waitFor(() => statusCalls() === 2);
    // Queued behind the in-flight refresh in the shared backup coordinator.
    click(button(view.host, 'Restore'));

    act(() => useConnectionStore.setState({ agentBaseUrl: 'http://agent-b.test' }));
    held.resolve(backupStatus());
    await waitFor(() => requests.some((url) => url.host === 'agent-b.test'));
    await Bun.sleep(25);

    expect(requests.some((url) => url.pathname === '/backup/restore')).toBe(false);
  });
});

describe('bulk import parse errors', () => {
  test('an invalid pretty-printed array reports the document error, not "Line 1"', () => {
    const result = parseInput('[\n  {"data": 1},\n  {"data": 2,}\n]');
    expect(result.items).toEqual([]);
    expect(result.error).toStartWith('Invalid JSON:');
    expect(result.error).not.toContain('Line 1');
  });

  test('NDJSON still points at the failing line once earlier lines parsed', () => {
    expect(parseInput('{"data":1}\n{"data":2}\n{data:3}').error).toStartWith('Line 3:');
    expect(parseInput('{"data":1}\n{"data":2}').items).toEqual([{ data: 1 }, { data: 2 }]);
  });
});

describe('cron next-run preview', () => {
  const values = (timezone: string) =>
    ({
      name: 'nightly',
      queue: 'reports',
      mode: 'cron',
      schedule: '0 9 * * *',
      every: '',
      dataText: '{}',
      timezone,
    }) as CronFormValues;

  test('without a timezone the preview is labelled browser-local with a server caveat', () => {
    const view = render(
      createElement(CronPrimaryFields, { values: values(''), setValue: () => undefined })
    );
    expect(view.host.textContent).toContain('Next runs (browser-local time)');
    expect(view.host.textContent).toContain('server evaluates in its own timezone');
  });

  test('with a timezone the preview names the server evaluation zone', () => {
    const view = render(
      createElement(CronPrimaryFields, {
        values: values('Europe/Rome'),
        setValue: () => undefined,
      })
    );
    expect(view.host.textContent).toContain('Next runs (browser-local time)');
    expect(view.host.textContent).toContain('server evaluates in Europe/Rome');
  });
});
