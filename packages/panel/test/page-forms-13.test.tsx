import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, createElement, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import {
  CONNECTION_STORAGE_KEY,
  useConnectionStore,
} from '../src/components/dashboard/stores/connectionStore';
import { S3_STORAGE_KEY, useS3Store } from '../src/components/dashboard/stores/s3Store';
import { ResultsTable } from '../src/pages/control/database/ResultsTable';
import { SchemaView } from '../src/pages/control/database/SchemaView';
import { McpServer } from '../src/pages/control/McpServer';
import { S3EnvironmentCard } from '../src/pages/control/s3Backup/S3EnvironmentCard';
import { S3BackupPro } from '../src/pages/control/S3BackupPro';
import { UsagePro } from '../src/pages/control/UsagePro';
import { ConnectionProfilesCard } from '../src/pages/settings/ConnectionProfilesCard';
import { ensureDom, settle } from './domSetup';

const mounted: Array<() => void> = [];
const realFetch = globalThis.fetch;

function render(element: ReactElement): HTMLElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(element));
  mounted.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  return host;
}

beforeEach(() => ensureDom());
afterEach(() => {
  for (const unmount of mounted.splice(0)) unmount();
  globalThis.fetch = realFetch;
  localStorage.removeItem(S3_STORAGE_KEY);
  localStorage.removeItem(CONNECTION_STORAGE_KEY);
  useConnectionStore.setState({ baseUrl: '/api', token: '', agentToken: '', refreshMs: 3000 });
});

describe('S3 server environment', () => {
  const value = [
    'S3_BUCKET=backups',
    'S3_ACCESS_KEY_ID=AKIA-LEAK-ME',
    'S3_SECRET_ACCESS_KEY=hunter2-LEAK-ME',
    'S3_SESSION_TOKEN=token-LEAK-ME',
  ].join('\n');

  test('the shown block hides every credential, and says what it is', () => {
    const host = render(createElement(S3EnvironmentCard, { environment: { ok: true, value } }));
    const region = host.querySelector('[role="region"]')!;
    expect(region.getAttribute('aria-label')).toBe('Server environment settings');
    expect(region.textContent).toContain('S3_BUCKET=backups');
    expect(region.textContent).toContain('S3_SECRET_ACCESS_KEY="••••••••"');
    expect(host.textContent).not.toContain('LEAK-ME');
  });

  test('a draft with errors lists each one and shows no block', () => {
    const host = render(
      createElement(S3EnvironmentCard, {
        environment: { ok: false, errors: ['Bucket is required.', 'Region is required.'] },
      })
    );
    const list = host.querySelector('ul[aria-label="Configuration errors"]')!;
    expect([...list.querySelectorAll('li')].map((li) => li.textContent)).toEqual([
      '• Bucket is required.',
      '• Region is required.',
    ]);
    expect(host.querySelector('[role="region"]')).toBeNull();
  });
});

describe('S3 backup page', () => {
  test('an unconfigured draft says "Configure" in a pill and explains where it applies', async () => {
    globalThis.fetch = (() =>
      Promise.resolve(Response.json({ ok: false, error: 'offline' }))) as unknown as typeof fetch;
    useS3Store.getState().set({ schedule: '6h', bucket: '', accessKeyId: '', secretAccessKey: '' });
    const host = render(createElement(MemoryRouter, null, createElement(S3BackupPro)));
    await settle(5);
    expect(host.querySelector('span.rounded-full')?.textContent).toBe('Configure');
    act(() =>
      useS3Store.getState().set({ bucket: 'backups', accessKeyId: 'id', secretAccessKey: 'key' })
    );
    await settle(2);
    expect(host.querySelector('span.rounded-full')?.textContent).toBe('Ready');
    const info = [...host.querySelectorAll('[role="status"]')].find((el) =>
      el.textContent?.includes('Configured on the server')
    );
    expect(info).toBeDefined();
    for (const id of ['s3-backup-schedule', 's3-addressing-style']) {
      expect(host.querySelector(`label[for="${id}"]`), id).not.toBeNull();
    }
  });
});

describe('Database results', () => {
  const props = {
    columns: ['id', 'name'],
    rows: [
      [1, 'alpha'],
      [2, null],
    ],
  };

  test('a sortable column names its state, numbers align right, and NULL is a word', () => {
    const host = render(
      createElement(ResultsTable, {
        ...props,
        sort: { col: 'id', dir: 'desc' },
        onSort: () => {},
        onRowClick: () => {},
      })
    );
    const th = (name: string) =>
      [...host.querySelectorAll('thead th')].find((h) => h.textContent?.includes(name))!;
    expect(th('id').getAttribute('aria-sort')).toBe('descending');
    expect(th('name').getAttribute('aria-sort')).toBe('none');
    expect(th('id').getAttribute('scope')).toBe('col');
    expect(th('id').classList.contains('text-right')).toBe(true);
    expect(th('name').classList.contains('text-right')).toBe(false);
    expect(host.querySelector('button[aria-label="Sort by id"]')!.className).toContain('min-h-8');
    expect(host.querySelectorAll('tbody tr')[1]!.textContent).toContain('NULL');
  });

  test('each row has a named View button that hands back its index', () => {
    const picked: number[] = [];
    const host = render(
      createElement(ResultsTable, { ...props, onRowClick: (i: number) => picked.push(i) })
    );
    act(() =>
      host.querySelector<HTMLButtonElement>('button[aria-label="View row 2 details"]')!.click()
    );
    expect(picked).toEqual([1]);
  });

  test('a read-only result has no sort buttons and no row actions column', () => {
    const host = render(createElement(ResultsTable, props));
    expect(host.querySelector('thead button')).toBeNull();
    expect(host.querySelectorAll('thead th')).toHaveLength(2);
  });
});

describe('Database schema', () => {
  const schema = {
    table: 'qcloud_jobs',
    columns: [
      { name: 'id', type: 'TEXT', notNull: true, defaultValue: null, primaryKey: true },
      { name: 'note', type: 'TEXT', notNull: false, defaultValue: "'none'", primaryKey: false },
    ],
    indexes: [{ name: 'jobs_by_state', unique: true, columns: ['state', 'created_at'] }],
    sql: 'CREATE TABLE qcloud_jobs (id TEXT PRIMARY KEY)',
    rowCount: 2,
  };

  test('constraints are words, the DDL is a named region, and the index lists its columns', () => {
    const host = render(createElement(SchemaView, { schema }));
    const rows = [...host.querySelectorAll('tbody tr')];
    expect(rows[0]!.textContent).toContain('PK');
    expect(rows[0]!.textContent).toContain('NOT NULL');
    expect(rows[1]!.textContent).toContain("'none'");
    expect(rows[1]!.textContent).not.toContain('NOT NULL');
    expect(host.textContent).toContain('jobs_by_state');
    expect(host.textContent).toContain('UNIQUE');
    expect(host.textContent).toContain('(state, created_at)');
    expect(host.querySelector('[role="region"][aria-label="DDL"]')?.textContent).toBe(schema.sql);
  });
});

describe('MCP reference page', () => {
  test('both warnings are banners with a title, and every snippet is a named region', () => {
    const host = render(createElement(MemoryRouter, null, createElement(McpServer)));
    const banners = [...host.querySelectorAll('[role="status"]')].filter((b) =>
      b.querySelector('strong')
    );
    expect(banners.map((b) => b.querySelector('strong')?.textContent)).toEqual([
      'Some tools are destructive',
      'Worker ID can come back as 0',
    ]);
    const regions = [...host.querySelectorAll('[role="region"]')].map((r) =>
      r.getAttribute('aria-label')
    );
    expect(regions).toEqual([
      'Install commands',
      'Embedded mode configuration',
      'TCP mode configuration',
      'Claude Code command',
    ]);
  });
});

function setInput(input: HTMLInputElement, value: string): void {
  act(() => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set?.call(
      input,
      value
    );
    const key = Object.getOwnPropertyNames(input).find((k) => k.startsWith('__reactProps$'))!;
    const props = (input as unknown as Record<string, { onChange: (e: unknown) => void }>)[key]!;
    props.onChange({ target: input });
  });
}

const press = (host: HTMLElement, label: string) =>
  act(() => [...host.querySelectorAll('button')].find((b) => b.textContent === label)!.click());

describe('Settings connection form', () => {
  test('a bad server URL is tied to its field, and a failed test is an alert', async () => {
    const host = render(createElement(ConnectionProfilesCard));
    await settle(3);
    const input = host.querySelector<HTMLInputElement>('input[name="server-url"]')!;
    expect(input.getAttribute('aria-invalid')).toBeNull();

    setInput(input, 'not a url');
    press(host, 'Save');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    const described = document.getElementById(input.getAttribute('aria-describedby')!)!;
    expect(described.textContent).toContain('http');

    press(host, 'Test connection');
    const alert = host.querySelector('[role="alert"]')!;
    expect(alert.querySelector('strong')?.textContent).toBe('The test did not pass');
  });
});

describe('Usage storage', () => {
  const overview = {
    ok: true,
    stats: {
      waiting: 1,
      active: 0,
      completed: 3,
      dlq: 0,
      totalPushed: 4,
      totalPulled: 3,
      uptime: 1,
    },
    throughput: { pushPerSec: 0, pullPerSec: 0 },
    memory: { heapUsed: 12, rss: 40 },
    crons: { total: 0 },
  };
  const serve = (storage: Record<string, unknown>) =>
    (globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = String(input);
      const body = url.endsWith('/storage')
        ? { ok: true, data: storage }
        : url.endsWith('/queues/summary')
          ? []
          : overview;
      return Promise.resolve(Response.json(body));
    }) as typeof fetch);

  test('a full disk is an alert with a title; a healthy one is a polite status', async () => {
    serve({ diskFull: true, error: 'ENOSPC', since: 1_000 });
    const full = render(createElement(MemoryRouter, null, createElement(UsagePro)));
    await settle(10);
    const alert = full.querySelector('[role="alert"]')!;
    expect(alert.querySelector('strong')?.textContent).toBe('Disk full — writes suspended');
    expect(alert.textContent).toContain('ENOSPC');

    serve({ diskFull: false });
    const ok = render(createElement(MemoryRouter, null, createElement(UsagePro)));
    await settle(10);
    expect(ok.querySelector('[role="alert"]')).toBeNull();
    expect(ok.textContent).toContain('Disk writes are being accepted.');
  });
});
