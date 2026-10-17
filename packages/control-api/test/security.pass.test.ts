import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { describeDb } from '../../../test/support/db';
import type { JobsApi, JobsFixture } from './jobsFixture';
import { openJobsFixture } from './jobsFixture';
import { documented } from './openapiSpec';
import { DEV_TOKEN } from './support';

/**
 * The Phase 2 security pass, over every operation `docs/openapi.yaml` documents: who may call it,
 * what a refusal says, and that the credential is never handed back. The narrower cases (CORS,
 * body caps, stream caps, audit rows, error bodies) have their own files; this one is the sweep,
 * so a route added later is held to the same rules without anyone remembering to ask.
 */

/** The reads a viewer is refused. Everything else a viewer may read. */
const OPERATOR_ONLY_READS = ['GET /audit', 'GET /transport/dead-letters'];

const operations = documented().map((entry) => {
  const [method, template] = entry.split(' ') as [string, string];
  return { entry, method, path: template.replace(/\{[^}]+\}/g, 'x') };
});
// A stream does not end by itself: its access rules are in events.test.ts and events.limits.test.ts.
const plain = operations.filter(({ path }) => !path.startsWith('/events'));

describeDb('security pass: every documented operation', () => {
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

  test('the document describes enough operations for the sweep to mean something', () => {
    expect(operations.length).toBeGreaterThan(60);
    expect(plain.length).toBeGreaterThan(55);
  });

  test('no operation but GET /health answers without a credential, and none echoes a bad one', async () => {
    for (const { entry, method, path } of operations) {
      if (entry === 'GET /health') continue;
      const none = await api.api.call(method, path, { token: null });
      expect([entry, none.status]).toEqual([entry, 401]);
      const bad = await api.api.call(method, path, { token: 'canary-not-a-token' });
      expect([entry, bad.status]).toEqual([entry, 401]);
      expect(await bad.text()).not.toContain('canary-not-a-token');
    }
  });

  test('a viewer is refused every change, and only the pinned reads', async () => {
    const refusedReads: string[] = [];
    for (const { entry, method, path } of plain) {
      const answer = await api.asViewer(method, path, method === 'GET' ? undefined : {});
      if (method !== 'GET') {
        expect([entry, answer.status]).toEqual([entry, 403]);
        expect(answer.body.error.code).toBe('forbidden');
      } else if (answer.status === 403) refusedReads.push(entry);
    }
    expect(refusedReads.sort()).toEqual(OPERATOR_ONLY_READS);
  });

  test('every answer is nosniff and no-store, whoever asked and whatever it was', async () => {
    for (const { entry, method, path } of plain) {
      for (const asViewer of [false, true]) {
        const body = method === 'GET' ? undefined : {};
        const answer = asViewer
          ? await api.asViewer(method, path, body)
          : await api.call(method, path, body);
        expect([entry, asViewer, answer.headers.get('x-content-type-options')]).toEqual([
          entry,
          asViewer,
          'nosniff',
        ]);
        expect([entry, asViewer, answer.headers.get('cache-control')]).toEqual([
          entry,
          asViewer,
          'no-store',
        ]);
        expect(answer.headers.get('x-request-id')).toMatch(/^[\w-]{8,64}$/);
      }
    }
  });

  test('the credential is in no response body and no log record, success or failure', async () => {
    const seen: string[] = [];
    for (const { method, path } of plain) {
      const answer = await api.call(method, path, method === 'GET' ? undefined : {});
      seen.push(JSON.stringify(answer.body ?? null), JSON.stringify([...answer.headers]));
    }
    const { requests, errors, warnings } = api.api.recorded;
    seen.push(JSON.stringify(requests), JSON.stringify(errors));
    // The one warning that names the development token must not carry it.
    seen.push(JSON.stringify(warnings));
    expect(requests.length).toBeGreaterThan(50);
    for (const text of seen) expect(text).not.toContain(DEV_TOKEN);
  });

  test('a path the router does not know is not a way past the check, for either role', async () => {
    for (const path of [
      '/queues/../audit',
      '/%2e%2e/audit',
      '/queues//jobs',
      '/AUDIT',
      '/audit%00',
    ]) {
      const none = await api.api.call('GET', path, { token: null });
      expect([path, none.status]).toEqual([path, 401]);
      const viewer = await api.asViewer('GET', path);
      expect([path, viewer.status === 200]).toEqual([path, false]);
    }
  });
});

describe('the sweep itself', () => {
  test('it is pinned to documented operations only', () => {
    expect(OPERATOR_ONLY_READS.every((entry) => documented().includes(entry))).toBe(true);
  });
});
