import { describe, expect, test } from 'bun:test';
import { StoreError } from '@qelay-cloud/core';
import { bodyOf, errorOf, harness, sampleOverview, sampleStats } from './support';

describe('GET /dashboard and GET /stats', () => {
  test('answer 501 not_implemented until the jobs and queues routes supply the reads', async () => {
    const api = harness();
    for (const path of ['/dashboard', '/stats']) {
      const response = await api.call('GET', path);
      expect(response.status).toBe(501);
      expect((await errorOf(response)).error.code).toBe('not_implemented');
    }
  });

  test('serve what the reader returns, as it is', async () => {
    const api = harness(
      {},
      { dashboard: { overview: async () => sampleOverview(), stats: async () => sampleStats() } }
    );
    expect(await bodyOf(await api.call('GET', '/dashboard'))).toEqual(sampleOverview() as never);
    expect(await bodyOf(await api.call('GET', '/stats'))).toEqual(sampleStats() as never);
  });

  test('need a token', async () => {
    const api = harness(
      {},
      { dashboard: { overview: async () => sampleOverview(), stats: async () => sampleStats() } }
    );
    for (const path of ['/dashboard', '/stats']) {
      expect((await api.call('GET', path, { token: null })).status).toBe(401);
    }
  });

  test('a failing read is a mapped error and shows no cause', async () => {
    const api = harness(
      {},
      {
        dashboard: {
          overview: async () => {
            throw new StoreError('SELECT count(*) FROM qcloud_jobs failed');
          },
          stats: async () => sampleStats(),
        },
      }
    );
    const response = await api.call('GET', '/dashboard');
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('qcloud_jobs');
  });
});
