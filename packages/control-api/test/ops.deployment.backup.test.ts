import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { describeDb } from '../../../test/support/db';
import { deploymentHarness } from './deploymentHarness';
import type { JobsFixture } from './jobsFixture';
import { openJobsFixture } from './jobsFixture';

describeDb('GET /deployment: the declared backup mechanism', () => {
  let f: JobsFixture;
  beforeAll(async () => {
    f = await openJobsFixture();
  });
  afterAll(() => f.drop());
  beforeEach(() => f.reset());
  const { open, deployment, codes, tickedAgo } = deploymentHarness(() => f);
  const look = async () => codes(await deployment(open({}, { readiness: tickedAgo(1_000) })));

  test('nobody has said how the database is backed up: a warning that points at the Backups page', async () => {
    const body = await deployment(open({}, { readiness: tickedAgo(1_000) }));
    const [warning] = body.warnings.filter((w: { code: string }) => w.code === 'backup_undeclared');
    expect(warning).toMatchObject({
      severity: 'warning',
      message: expect.stringContaining('Backups page'),
    });
  });

  test('"none" is a warning; the provider\'s backups and the operator\'s own are not', async () => {
    await f.store.backups.set({ mechanism: 'none' }, 'ops');
    expect(await look()).toContain('backup_none');
    expect(await look()).not.toContain('backup_undeclared');

    await f.store.backups.set({ mechanism: 'provider' }, 'ops');
    expect(await look()).not.toContain('backup_none');

    await f.store.backups.set({ mechanism: 'external', tool: 'pgBackRest' }, 'ops');
    const codesNow = await look();
    expect(codesNow).not.toContain('backup_none');
    expect(codesNow).not.toContain('backup_undeclared');
  });
});
