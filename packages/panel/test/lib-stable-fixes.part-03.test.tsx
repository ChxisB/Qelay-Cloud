import { afterEach, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import {
  CONNECTION_STORAGE_KEY,
  useConnectionStore,
} from '../src/components/dashboard/stores/connectionStore';
import { S3_STORAGE_KEY, useS3Store } from '../src/components/dashboard/stores/s3Store';
import { parseRetentionDraft } from '../src/pages/control/s3Backup/retentionDraft';
import { S3BackupPro } from '../src/pages/control/S3BackupPro';
import { ensureDom, settle } from './domSetup';

// Regressions: (1) legacy v2 `/api` connection state never reached migrate's
// runtime-mount rewrite through real hydration; (6) S3 retention input values
// were coerced to 7, so the page's range error could never be shown.

ensureDom();
const projectRoot = resolve(import.meta.dir, '..');
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  localStorage.removeItem(CONNECTION_STORAGE_KEY);
  localStorage.removeItem(S3_STORAGE_KEY);
  useConnectionStore.setState({ baseUrl: '/api', token: '', agentToken: '', refreshMs: 3000 });
});

/** Fresh process: CONNECTION_DEFAULTS reads the runtime mount at module load. */
async function hydrateUnderMount(envelope: unknown): Promise<Record<string, unknown>> {
  const script = `
    globalThis.__QELAY_API_URL__ = '/internal/queue/api';
    localStorage.setItem(${JSON.stringify(CONNECTION_STORAGE_KEY)}, ${JSON.stringify(JSON.stringify(envelope))});
    const { useConnectionStore } = await import('./src/components/dashboard/stores/connectionStore.ts');
    await useConnectionStore.persist.rehydrate();
    const { baseUrl, profiles, token, agentToken } = useConnectionStore.getState();
    const stored = localStorage.getItem(${JSON.stringify(CONNECTION_STORAGE_KEY)});
    console.log(JSON.stringify({ baseUrl, profiles, token, agentToken, stored }));
  `;
  const env = { ...Bun.env };
  delete env.VITE_QELAY_URL;
  delete env.VITE_QELAY_AGENT_URL;
  const child = Bun.spawn([process.execPath, '--preload', './test/setup.ts', '-e', script], {
    cwd: projectRoot,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(stderr).toBe('');
  expect(code).toBe(0);
  return JSON.parse(stdout.trim().split('\n').at(-1) ?? '{}') as Record<string, unknown>;
}

describe('legacy connection state under a runtime sub-path mount', () => {
  test('persist.rehydrate() rewrites the implicit v2 /api default and drops secrets', async () => {
    const result = await hydrateUnderMount({
      state: { baseUrl: '/api', refreshMs: 2000, token: 'legacy-token', agentToken: 'agent' },
      version: 2,
    });
    expect(result.baseUrl).toBe('/internal/queue/api');
    expect(result.profiles).toEqual([
      expect.objectContaining({ id: 'default', baseUrl: '/internal/queue/api' }),
    ]);
    expect(result.token).toBe('');
    expect(result.agentToken).toBe('');
    const stored = String(result.stored);
    expect(JSON.parse(stored)).toMatchObject({
      state: { profiles: [{ baseUrl: '/internal/queue/api' }], refreshMs: 2000 },
      version: 4,
    });
    expect(stored).not.toContain('legacy-token');
    expect(stored).not.toContain('agentToken');
  });

  test('explicit legacy URLs and current-version /api profiles are kept', async () => {
    const legacy = await hydrateUnderMount({
      state: { baseUrl: 'https://queue.example/api', refreshMs: 3000 },
      version: 2,
    });
    expect(legacy.baseUrl).toBe('https://queue.example/api');
    const current = await hydrateUnderMount({
      state: {
        profiles: [{ id: 'default', name: 'Local', baseUrl: '/api', agentBaseUrl: '/agent' }],
        activeProfileId: 'default',
        refreshMs: 3000,
      },
      version: 4,
    });
    expect(current.baseUrl).toBe('/api');
  });

  test('a corrupt legacy entry still hydrates safe defaults in-process', async () => {
    localStorage.setItem(CONNECTION_STORAGE_KEY, JSON.stringify({ state: 'garbage', version: 2 }));
    await useConnectionStore.persist.rehydrate();
    expect(useConnectionStore.getState()).toMatchObject({ baseUrl: '/api', token: '' });
    expect(JSON.parse(localStorage.getItem(CONNECTION_STORAGE_KEY) ?? 'null')).toMatchObject({
      version: 4,
    });
  });
});

function setInput(input: HTMLInputElement, value: string): void {
  act(() => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set?.call(
      input,
      value
    );
    const propsKey = Object.getOwnPropertyNames(input).find((key) =>
      key.startsWith('__reactProps$')
    );
    const props = propsKey
      ? ((input as unknown as Record<string, unknown>)[propsKey] as {
          onChange?: (event: { target: HTMLInputElement }) => void;
        })
      : undefined;
    props?.onChange?.({ target: input });
  });
}

describe('S3 retention draft', () => {
  test('parses blank text as invalid instead of zero', () => {
    expect(parseRetentionDraft('')).toBeNaN();
    expect(parseRetentionDraft('  ')).toBeNaN();
    expect(parseRetentionDraft(' 30 ')).toBe(30);
  });

  test('invalid typed values surface the range error and never reach the store', async () => {
    globalThis.fetch = (() =>
      Promise.resolve(Response.json({ ok: false, error: 'offline' }))) as unknown as typeof fetch;
    useS3Store.getState().set({
      region: 'us-east-1',
      bucket: 'backups',
      accessKeyId: 'access',
      secretAccessKey: 'secret',
      schedule: '6h',
      retention: 14,
    });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => root.render(createElement(MemoryRouter, null, createElement(S3BackupPro))));
    try {
      await settle(5);
      const input = host.querySelector('input[name="s3-retention"]') as HTMLInputElement;
      const error = 'Retention must be a whole number from 1 to 1000000.';
      expect(host.textContent).not.toContain(error);

      for (const typed of ['', '2000000', '1.5']) {
        setInput(input, typed);
        expect(input.value, typed).toBe(typed);
        expect(host.textContent, typed).toContain(error);
        expect(host.textContent, typed).toContain('Configuration draft incomplete');
        expect(useS3Store.getState().retention, typed).toBe(14);
      }
      const persisted = JSON.parse(localStorage.getItem(S3_STORAGE_KEY) ?? '{}');
      expect(persisted.state.retention).toBe(14);

      setInput(input, '30');
      expect(host.textContent).not.toContain(error);
      expect(useS3Store.getState().retention).toBe(30);
      expect(host.textContent).toContain('Configuration draft complete');
    } finally {
      act(() => root.unmount());
      host.remove();
      useS3Store.getState().set({
        region: 'us-east-1',
        bucket: '',
        accessKeyId: '',
        secretAccessKey: '',
        schedule: 'disabled',
        retention: 7,
      });
    }
  });
});
