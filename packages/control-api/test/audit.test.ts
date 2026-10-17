import { afterAll, beforeAll, beforeEach, expect, spyOn, test } from 'bun:test';
import { describeDb } from '../../../test/support/db';
import { claimOne } from '../../store-postgres/test/finishHelpers';
import type { JobsApi, JobsFixture } from './jobsFixture';
import { openJobsFixture } from './jobsFixture';
import { documented } from './openapiSpec';
import { DEV_TOKEN, errorOf, harness } from './support';

describeDb('operator audit log', () => {
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

  /** The log, newest first. */
  const rows = async () => (await f.store.audit.list({ limit: 500 })).items;
  const last = async () => (await rows())[0]!;

  test('an accepted change is one closed entry naming who, what, on which identifiers, and the answer', async () => {
    const answer = await api.call('POST', '/queues/emails/pause');
    expect(answer.status).toBe(200);
    const all = await rows();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      subject: expect.any(String),
      role: 'operator',
      source: 'dev-token',
      action: 'POST /queues/:queue/pause',
      target: 'queue=emails',
      outcome: 'success',
      status: 200,
      reason: null,
    });
    expect(all[0]!.finishedAt).toBeGreaterThanOrEqual(all[0]!.occurredAt);
    expect(answer.headers.get('x-request-id')).toBe(all[0]!.requestId);
  });

  test('a cron names itself in the entry even though the path does not carry it', async () => {
    await api.call('POST', '/crons', { name: 'nightly', queue: 'q', repeatEvery: 60_000 });
    expect(await last()).toMatchObject({
      action: 'POST /crons',
      target: 'nightly',
      outcome: 'success',
      status: 201,
    });
  });

  test('every documented mutation writes exactly one closed entry, whatever it answers', async () => {
    const mutations = documented().filter((entry) => !entry.startsWith('GET '));
    expect(mutations.length).toBeGreaterThan(25);
    for (const entry of mutations) {
      const [method, template] = entry.split(' ') as [string, string];
      const path = template.replace(/\{[^}]+\}/g, 'x');
      const before = (await rows()).length;
      const answer = await api.call(method, path, {});
      const after = await rows();
      expect(after.length, `${entry} (${answer.status})`).toBe(before + 1);
      // The router spells a trailing wildcard `*`, and the spec spells it `{path}`.
      const routed = template.replace(/\/\{path\}$/, '/*').replace(/\{([^}]+)\}/g, ':$1');
      expect(after[0]!.action, entry).toBe(`${method} ${routed}`);
      expect(after[0]!.outcome, entry).not.toBe('pending');
      expect(after[0]!.status, entry).toBe(answer.status);
    }
  });

  test('a refusal is an entry with its reason: confirmation, validation, missing target', async () => {
    await api.call('POST', '/queues/q/dlq/purge');
    expect(await last()).toMatchObject({
      action: 'POST /queues/:queue/dlq/purge',
      target: 'queue=q',
      outcome: 'rejected',
      status: 400,
      reason: 'confirmation_required',
    });
    await api.call('POST', '/crons', { name: 'bad', queue: 'q', schedule: 'nope' });
    expect(await last()).toMatchObject({
      action: 'POST /crons',
      outcome: 'rejected',
      status: 400,
      reason: 'unsupported_option',
    });
    await api.call('DELETE', '/crons/missing');
    expect(await last()).toMatchObject({
      action: 'DELETE /crons/:name',
      target: 'name=missing',
      outcome: 'rejected',
      status: 404,
      reason: 'cron_not_found',
    });
  });

  test('a viewer that tries a change is refused and the attempt is on record under its own role', async () => {
    const answer = await api.asViewer('POST', '/queues/q/pause');
    expect(answer.status).toBe(403);
    expect(await last()).toMatchObject({
      role: 'viewer',
      action: 'POST /queues/:queue/pause',
      target: 'queue=q',
      outcome: 'rejected',
      status: 403,
      reason: 'forbidden',
    });
    expect((await api.call('GET', '/queues/q/paused')).body.paused).toBe(false);
  });

  test('a failure is recorded as failed, and a change that cannot be recorded is not made', async () => {
    const broken = spyOn(f.store.queues, 'setStallConfig').mockRejectedValue(new Error('boom'));
    try {
      const answer = await api.call('PUT', '/queues/q/stall-config', { maxStalls: 2 });
      expect(answer.status).toBe(500);
    } finally {
      broken.mockRestore();
    }
    expect(await last()).toMatchObject({ outcome: 'failed', status: 500 });

    const before = (await rows()).length;
    const down = spyOn(f.store.audit, 'begin').mockRejectedValue(new Error('audit down'));
    try {
      const answer = await api.call('POST', '/queues/q/pause');
      expect(answer.status).toBe(503);
      expect(answer.body.error.code).toBe('audit_unavailable');
    } finally {
      down.mockRestore();
    }
    expect((await api.call('GET', '/queues/q/paused')).body.paused).toBe(false);
    expect((await rows()).length).toBe(before);
  });

  test('reads, unauthenticated calls and unknown routes are not entries', async () => {
    await api.call('GET', '/queues');
    await api.call('GET', '/crons');
    await api.api.call('POST', '/queues/q/pause', { token: null });
    await api.call('POST', '/no-such-route', {});
    expect(await rows()).toEqual([]);
  });

  test('an entry holds identifiers only: no payload, no query string, no credential', async () => {
    const secret = 'hunter2-payload-secret';
    await api.call('POST', '/queues/q/jobs', { name: 'j', data: { password: secret } });
    await api.call('POST', '/crons', {
      name: 'c',
      queue: 'q',
      repeatEvery: 60_000,
      data: { token: secret },
    });
    await api.call('POST', '/queues/q/pause?note=query-secret-value');
    const job = await claimOne(f.t, {}, 'q2', 'w');
    await api.call('PUT', `/jobs/${job.id}/data`, { data: { card: secret } });
    const text = JSON.stringify(await rows());
    for (const leaked of [secret, 'query-secret-value', DEV_TOKEN]) {
      expect(text.includes(leaked), leaked).toBe(false);
    }
    expect((await rows()).length).toBe(4);
  });

  test('GET /audit lists newest first and says what it was for', async () => {
    await api.call('POST', '/queues/a/pause');
    await api.call('POST', '/queues/b/pause');
    await api.call('POST', '/queues/b/resume');
    const answer = await api.call('GET', '/audit');
    expect(answer.status).toBe(200);
    expect(answer.body.ok).toBe(true);
    expect(answer.body.entries.map((entry: { action: string }) => entry.action)).toEqual([
      'POST /queues/:queue/resume',
      'POST /queues/:queue/pause',
      'POST /queues/:queue/pause',
    ]);
    expect(answer.body.entries[0]).toEqual(
      expect.objectContaining({
        id: expect.any(Number),
        occurredAt: expect.any(Number),
        finishedAt: expect.any(Number),
        subject: expect.any(String),
        role: 'operator',
        source: 'dev-token',
        requestId: expect.any(String),
        target: 'queue=b',
        outcome: 'success',
        status: 200,
        reason: null,
      })
    );
    expect(answer.body.next).toBeNull();
  });

  test('GET /audit pages by entry id and filters by outcome and action', async () => {
    for (const queue of ['a', 'b', 'c', 'd', 'e']) await api.call('POST', `/queues/${queue}/pause`);
    await api.call('POST', '/queues/a/drain');
    const first = await api.call('GET', '/audit?limit=4');
    expect(first.body.entries).toHaveLength(4);
    expect(typeof first.body.next).toBe('number');
    const second = await api.call('GET', `/audit?limit=4&before=${first.body.next}`);
    expect(second.body.entries).toHaveLength(2);
    expect(second.body.next).toBeNull();
    const ids = [...first.body.entries, ...second.body.entries].map(
      (entry: { id: number }) => entry.id
    );
    expect(new Set(ids).size).toBe(6);

    const rejected = await api.call('GET', '/audit?outcome=rejected');
    expect(rejected.body.entries).toHaveLength(1);
    expect(rejected.body.entries[0]).toMatchObject({ reason: 'confirmation_required' });
    const pauses = await api.call('GET', '/audit?action=POST%20/queues/:queue/pause');
    expect(pauses.body.entries).toHaveLength(5);
    const bad = await api.call('GET', '/audit?outcome=maybe');
    expect(bad.status).toBe(400);
  });

  test('GET /audit needs the operator role, even for a read', async () => {
    await api.call('POST', '/queues/a/pause');
    const answer = await api.asViewer('GET', '/audit');
    expect(answer.status).toBe(403);
    expect(answer.body.error.code).toBe('forbidden');
  });

  test('without an audit log GET /audit is 501 and nothing claims to have been recorded', async () => {
    const bare = harness({ devToken: { token: DEV_TOKEN, role: 'operator' }, rateLimit: false });
    const answer = await bare.call('GET', '/audit');
    expect(answer.status).toBe(501);
    expect((await errorOf(answer)).error.code).toBe('not_implemented');
  });
});
