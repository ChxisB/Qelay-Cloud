import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { describeDb } from '../../../test/support/db';
import type { JobsApi, JobsFixture } from './jobsFixture';
import { openJobsFixture } from './jobsFixture';
import { keysFit } from './openapiSpec';

describeDb('backup policy routes: how the operator says the database is backed up', () => {
  let f: JobsFixture;
  let api: JobsApi;
  beforeAll(async () => {
    f = await openJobsFixture();
  });
  afterAll(() => f.drop());
  beforeEach(async () => {
    await f.reset();
    api = f.api();
  });

  const put = (body: unknown) => api.call('PUT', '/backup-policy', body);

  test('nobody has said: the policy is null, and a viewer may read it', async () => {
    const answer = await api.call('GET', '/backup-policy');
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({ ok: true, data: { policy: null } });
    expect((await api.asViewer('GET', '/backup-policy')).status).toBe(200);
  });

  test('each mechanism is saved, read back, and replaced as a whole', async () => {
    const external = await put({
      mechanism: 'external',
      tool: 'pgBackRest',
      location: 'gs://acme-backups',
    });
    expect(external.status).toBe(200);
    expect(external.body.data.policy).toMatchObject({
      mechanism: 'external',
      tool: 'pgBackRest',
      location: 'gs://acme-backups',
    });
    expect(keysFit(external.body.data.policy, 'BackupPolicy')).toEqual([]);
    expect((await api.call('GET', '/backup-policy')).body.data.policy).toEqual(
      external.body.data.policy
    );

    // `provider` replaces it whole: the tool and location of the last declaration are gone, not kept.
    const provider = await put({ mechanism: 'provider' });
    expect(provider.body.data.policy).toMatchObject({
      mechanism: 'provider',
      tool: null,
      location: null,
    });
    const none = await put({ mechanism: 'none', tool: null, location: null });
    expect(none.body.data.policy).toMatchObject({ mechanism: 'none', tool: null, location: null });
    expect((await api.call('GET', '/backup-policy')).body.data.policy.mechanism).toBe('none');
  });

  test('a body that does not fit is a 400 and leaves the declaration alone', async () => {
    await put({ mechanism: 'provider' });
    for (const body of [
      {},
      { mechanism: 'tape' },
      { mechanism: 'external' },
      { mechanism: 'external', tool: '   ' },
      { mechanism: 'provider', tool: 'pgBackRest' },
      { mechanism: 'none', location: 'gs://x' },
      { mechanism: 'external', tool: 'x'.repeat(401) },
      { mechanism: 'external', tool: 'pgBackRest', location: 'x'.repeat(1_001) },
      { mechanism: 'provider', extra: 1 },
    ]) {
      expect((await put(body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await api.call('GET', '/backup-policy')).body.data.policy.mechanism).toBe('provider');
  });

  test('a viewer cannot declare, and the declaration names the principal that made it', async () => {
    expect((await api.asViewer('PUT', '/backup-policy', { mechanism: 'none' })).status).toBe(403);
    expect((await api.call('GET', '/backup-policy')).body.data.policy).toBeNull();

    const saved = (await put({ mechanism: 'none' })).body.data.policy;
    expect(typeof saved.updatedBy).toBe('string');
    expect(saved.updatedBy.length).toBeGreaterThan(0);
    expect(saved.updatedAt).toBe(f.t.clock.now());
  });

  test('a save is audited with the mechanism and not the tool or the location', async () => {
    await put({
      mechanism: 'external',
      tool: 'private-looking-tool',
      location: 'gs://private-looking-bucket',
    });
    const [entry] = (await f.store.audit.list({ limit: 1 })).items;
    expect(entry).toMatchObject({ action: 'PUT /backup-policy', status: 200 });
    expect(JSON.stringify(entry)).toContain('backupPolicy external');
    expect(JSON.stringify(entry)).not.toContain('private-looking');
  });
});
