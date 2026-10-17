import { describe, expect, test } from 'bun:test';
import { WORKFLOWS_SINCE_VERSION } from '@qelay-cloud/store-postgres';
import { MemoryTransport } from '@qelay-cloud/transport-local';
import type { ControlApiDeps } from '../src';
import { capabilities } from '../src/routes/capabilities';
import { fakeReadiness } from './support';

/** `features.workflows` for a process with the jobs routes (when `jobs`) and the schema probe given. */
async function workflows(
  schemaVersion: (() => Promise<number | null>) | undefined,
  extra: Partial<ControlApiDeps> = {},
  jobs = true
): Promise<boolean> {
  const deps = {
    transport: { name: 'memory', capabilities: new MemoryTransport().capabilities },
    readiness: fakeReadiness(schemaVersion === undefined ? {} : { schemaVersion }),
    ...(jobs ? { jobs: {} } : {}),
    ...extra,
  } as unknown as ControlApiDeps;
  return (await capabilities(deps, '0.0.0-test', 'viewer')).features.workflows;
}

describe('features.workflows', () => {
  test('is on when the workflow tables are migrated', async () => {
    expect(await workflows(async () => WORKFLOWS_SINCE_VERSION)).toBe(true);
    expect(await workflows(async () => WORKFLOWS_SINCE_VERSION + 5)).toBe(true);
  });

  test('is off for a schema from before the workflow tables, and when the version is unknown or the probe fails', async () => {
    expect(await workflows(async () => WORKFLOWS_SINCE_VERSION - 1)).toBe(false);
    expect(await workflows(async () => 0)).toBe(false);
    expect(await workflows(async () => null)).toBe(false);
    expect(
      await workflows(async () => {
        throw new Error('database is down');
      })
    ).toBe(false);
  });

  test('is on without a probe (the store is taken as migrated) and off without the jobs routes', async () => {
    expect(await workflows(undefined)).toBe(true);
    expect(await workflows(async () => WORKFLOWS_SINCE_VERSION, {}, false)).toBe(false);
  });

  test('is what the process declares when it declares one', async () => {
    const ready = async () => WORKFLOWS_SINCE_VERSION;
    expect(await workflows(ready, { features: { workflows: false } })).toBe(false);
    expect(await workflows(async () => 1, { features: { workflows: true } })).toBe(true);
  });

  test('the answer follows the schema when it is migrated later', async () => {
    let version = WORKFLOWS_SINCE_VERSION - 1;
    const probe = async () => version;
    expect(await workflows(probe)).toBe(false);
    version = WORKFLOWS_SINCE_VERSION;
    expect(await workflows(probe)).toBe(true);
  });
});
