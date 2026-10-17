import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { LEGACY_STORAGE_KEYS, readWithLegacy } from '../src/lib/legacyStorage';

const projectRoot = resolve(import.meta.dir, '..');

/** Map-backed Storage whose reads and writes can be made to throw. */
function fakeStorage(
  seed: Record<string, string> = {},
  fail: { get?: boolean; set?: boolean } = {}
) {
  const data = new Map(Object.entries(seed));
  const storage = {
    getItem(key: string) {
      if (fail.get) throw new Error('blocked');
      return data.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      if (fail.set) throw new Error('quota');
      data.set(key, value);
    },
    removeItem(key: string) {
      data.delete(key);
    },
  } as unknown as Storage;
  return { storage, data };
}

describe('readWithLegacy', () => {
  test('adopts the old value byte-for-byte, then removes the old key', () => {
    const raw = ' {"state":{"theme":"light"},\n "version":1}\t';
    const { storage, data } = fakeStorage({ old: raw });
    expect(readWithLegacy(storage, 'new', 'old')).toBe(raw);
    expect(data.get('new')).toBe(raw);
    expect(data.has('old')).toBe(false);
  });

  test('is idempotent: a second read changes nothing', () => {
    const { storage, data } = fakeStorage({ old: 'v' });
    readWithLegacy(storage, 'new', 'old');
    expect(readWithLegacy(storage, 'new', 'old')).toBe('v');
    expect([...data.entries()]).toEqual([['new', 'v']]);
  });

  test('an existing new value wins and the old key is left alone', () => {
    const { storage, data } = fakeStorage({ old: 'old-value', new: 'new-value' });
    expect(readWithLegacy(storage, 'new', 'old')).toBe('new-value');
    expect(data.get('new')).toBe('new-value');
    expect(data.get('old')).toBe('old-value');
  });

  test('returns null when neither key exists', () => {
    const { storage, data } = fakeStorage();
    expect(readWithLegacy(storage, 'new', 'old')).toBeNull();
    expect(data.size).toBe(0);
  });

  test('a failed copy still serves the old value and keeps it for the next load', () => {
    const { storage, data } = fakeStorage({ old: 'kept' }, { set: true });
    expect(readWithLegacy(storage, 'new', 'old')).toBe('kept');
    expect(data.get('old')).toBe('kept');
    expect(data.has('new')).toBe(false);
  });

  test('blocked storage yields null instead of throwing', () => {
    const { storage } = fakeStorage({ old: 'x' }, { get: true });
    expect(readWithLegacy(storage, 'new', 'old')).toBeNull();
  });
});

/**
 * A fresh process seeds ONLY the old keys, then imports every persisted store with
 * no explicit rehydrate. This is the ordering hazard the migration must survive: a
 * store built before the shim runs would persist defaults under the new key and
 * orphan the user's data.
 */
async function hydrateFromOldKeysOnly(): Promise<Record<string, unknown>> {
  const L = LEGACY_STORAGE_KEYS;
  const script = `
    const seed = (key, value) => localStorage.setItem(key, JSON.stringify(value));
    seed(${JSON.stringify(L.theme)}, { state: { theme: 'light' }, version: 1 });
    seed(${JSON.stringify(L.alerts)}, {
      state: { channels: [{ id: 'mail', type: 'email', target: 'ops@example.com' }], rules: [] },
      version: 1,
    });
    seed(${JSON.stringify(L.s3)}, {
      state: { endpoint: 'https://s3.example', region: 'eu-west-1', bucket: 'my-bucket' },
      version: 1,
    });
    seed(${JSON.stringify(L.copilot)}, {
      state: { config: { provider: 'custom', baseURL: 'https://llm.example/v1', model: 'local-model' } },
      version: 1,
    });
    seed(${JSON.stringify(L.connection)}, { state: { baseUrl: '/api', refreshMs: 5000 }, version: 2 });
    seed(${JSON.stringify(L.dbHistory)}, ['SELECT 1']);

    const { useThemeStore } = await import('./src/components/dashboard/stores/themeStore.ts');
    const { useAlertsStore } = await import('./src/components/dashboard/stores/alertsStore.ts');
    const { useS3Store } = await import('./src/components/dashboard/stores/s3Store.ts');
    const { useCopilotStore } = await import('./src/components/dashboard/stores/copilotStore.ts');
    const { useConnectionStore } = await import('./src/components/dashboard/stores/connectionStore.ts');
    const { loadHistory } = await import('./src/pages/control/database/dbUtils.ts');

    const names = ['theme', 'alerts', 's3', 'copilot', 'connection'];
    const keys = ${JSON.stringify(L)};
    const newKeys = {
      theme: 'qelay-theme', alerts: 'qelay-alerts', s3: 'qelay-s3',
      copilot: 'qelay-copilot', connection: 'qelay-connection',
    };
    console.log(JSON.stringify({
      theme: useThemeStore.getState().theme,
      channels: useAlertsStore.getState().channels,
      s3: [useS3Store.getState().region, useS3Store.getState().bucket],
      model: useCopilotStore.getState().config.model,
      refreshMs: useConnectionStore.getState().refreshMs,
      history: loadHistory(),
      oldGone: names.every((n) => localStorage.getItem(keys[n]) === null),
      newPresent: names.every((n) => localStorage.getItem(newKeys[n]) !== null),
      oldHistoryGone: localStorage.getItem(keys.dbHistory) === null,
    }));
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

describe('browser profile that only has pre-rebrand keys', () => {
  test('every store comes up with the saved data and the old keys are gone', async () => {
    const result = await hydrateFromOldKeysOnly();
    expect(result.theme).toBe('light');
    expect(result.channels).toEqual([{ id: 'mail', type: 'email', target: 'ops@example.com' }]);
    expect(result.s3).toEqual(['eu-west-1', 'my-bucket']);
    expect(result.model).toBe('local-model');
    expect(result.refreshMs).toBe(5000);
    expect(result.history).toEqual(['SELECT 1']);
    expect(result.oldGone).toBe(true);
    expect(result.newPresent).toBe(true);
    expect(result.oldHistoryGone).toBe(true);
  });
});

describe('pre-paint theme script in index.html', () => {
  const html = readFileSync(resolve(projectRoot, 'index.html'), 'utf8');
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? '';

  function run(stored: Record<string, string>) {
    const dataset: Record<string, string> = {};
    const style: Record<string, string> = {};
    const localStorage = { getItem: (key: string) => stored[key] ?? null };
    const document = { documentElement: { dataset, style } };
    runInNewContext(script, { localStorage, document });
    return { theme: dataset.theme, scheme: style.colorScheme };
  }
  const envelope = (theme: string) => JSON.stringify({ state: { theme }, version: 1 });

  test('reads the new key', () => {
    expect(run({ 'qelay-theme': envelope('light') })).toEqual({ theme: 'light', scheme: 'light' });
  });

  test('falls back to the old key so there is no flash on the first load after upgrade', () => {
    expect(run({ [LEGACY_STORAGE_KEYS.theme]: envelope('light') })).toEqual({
      theme: 'light',
      scheme: 'light',
    });
  });

  test('the new key wins when both exist', () => {
    const stored = {
      'qelay-theme': envelope('dark'),
      [LEGACY_STORAGE_KEYS.theme]: envelope('light'),
    };
    expect(run(stored).theme).toBe('dark');
  });

  test('nothing stored leaves the default theme in place', () => {
    expect(run({})).toEqual({ theme: undefined, scheme: undefined });
  });
});
