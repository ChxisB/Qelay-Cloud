import { describe, expect, test } from 'bun:test';
import type {
  CapabilitiesResponse,
  ErrorBody,
  OverviewResponse as OurOverview,
  StatsResponse as OurStats,
} from '../../src';
import { bodyOf, fakeReadiness, harness, sampleOverview, sampleStats } from '../support';
import { panelAcceptsHealth, panelReadinessProbe } from './shapes/panel-consumers';
import type {
  OverviewResponse as PanelOverview,
  ReadinessResponse as PanelReadiness,
  StatsResponse as PanelStats,
} from './shapes/panel-types';
import { capabilitiesSchema, errorSchema, overviewSchema, statsSchema } from './shapes/schemas';

// What the service declares it sends must fit what the panel reads. A readonly array is not
// assignable to a mutable one, which says nothing about JSON, so the declared types are made mutable
// first.
type DeepMutable<T> = T extends readonly (infer U)[]
  ? DeepMutable<U>[]
  : T extends object
    ? { -readonly [K in keyof T]: DeepMutable<T[K]> }
    : T;
type Assert<T extends true> = T;
type Fits<Sent, Read> = [Sent] extends [Read] ? true : false;
export type SentOverviewFitsThePanel = Assert<Fits<DeepMutable<OurOverview>, PanelOverview>>;
export type SentStatsFitsThePanel = Assert<Fits<DeepMutable<OurStats>, PanelStats>>;
export type SentReadinessFitsThePanel = Assert<
  Fits<DeepMutable<{ ok: true; ready: true }>, PanelReadiness>
>;

const reader = { overview: async () => sampleOverview(), stats: async () => sampleStats() };

describe('the panel reads what the service sends', () => {
  test('GET /health passes the panel connection test', async () => {
    const api = harness({ version: '1.4.0' });
    const body = await bodyOf(await api.call('GET', '/health', { token: null }));
    expect(panelAcceptsHealth(body)).toBe(true);
  });

  test('the panel connection test refuses what it should, so the check above means something', () => {
    expect(panelAcceptsHealth({ ok: true, version: '1.0.0' })).toBe(false);
    expect(panelAcceptsHealth({ ok: true, status: 'healthy', uptime: 1, version: 'dev' })).toBe(
      false
    );
  });

  test('GET /ready: ready is the panel "Ready" row', async () => {
    const body = await bodyOf<PanelReadiness>(await harness().call('GET', '/ready'));
    expect(panelReadinessProbe(body)).toEqual({
      label: 'Ready',
      detail: 'Persistence accepts traffic',
    });
  });

  test('GET /ready: a failed database is the panel "Not ready" row, and does not throw', async () => {
    const down = harness(
      {},
      {
        readiness: fakeReadiness({
          database: async () => {
            throw new Error('down');
          },
        }),
      }
    );
    const response = await down.call('GET', '/ready');
    expect(response.status).toBe(503);
    expect(panelReadinessProbe(await bodyOf<PanelReadiness>(response))).toEqual({
      label: 'Not ready',
      detail: 'the database is unavailable',
    });
  });

  test('GET /dashboard fits the overview the panel reads', async () => {
    const response = await harness({}, { dashboard: reader }).call('GET', '/dashboard');
    expect(overviewSchema.safeParse(await response.json()).success).toBe(true);
  });

  test('GET /stats fits the statistics the panel reads', async () => {
    const response = await harness({}, { dashboard: reader }).call('GET', '/stats');
    expect(statsSchema.safeParse(await response.json()).success).toBe(true);
  });

  test('the schemas refuse a payload the panel could not render', () => {
    const { workers: _workers, ...withoutWorkers } = sampleOverview();
    expect(overviewSchema.safeParse(withoutWorkers).success).toBe(false);
    expect(statsSchema.safeParse({ ...sampleStats(), memory: { heapUsed: 1 } }).success).toBe(
      false
    );
  });
});

describe('GET /capabilities and the error body', () => {
  test('capabilities fit their schema', async () => {
    const body = await bodyOf<CapabilitiesResponse>(await harness().call('GET', '/capabilities'));
    expect(capabilitiesSchema.safeParse(body).success).toBe(true);
  });

  test('every error the pipeline makes has exactly { error: { code, message, details? } }', async () => {
    const api = harness({ maxBodyBytes: 50 });
    const responses = [
      await api.call('GET', '/test/read', { token: null }),
      await api.call('POST', '/test/write', { token: null }),
      await api.call('GET', '/nowhere'),
      await api.call('DELETE', '/test/read'),
      await api.call('POST', '/test/write', {
        raw: '{',
        headers: { 'content-type': 'application/json' },
      }),
      await api.call('POST', '/test/write', { body: { name: 'x'.repeat(100) } }),
      await api.call('GET', '/test/slow'),
      await api.call('GET', '/dashboard'),
    ];
    expect(responses.map((response) => response.status)).toEqual([
      401, 401, 404, 405, 400, 413, 504, 501,
    ]);
    for (const response of responses) {
      const body = await bodyOf<ErrorBody>(response);
      expect(errorSchema.safeParse(body).success).toBe(true);
    }
  });

  test('a 501 for something Qelay did and this service does not names the capability', () => {
    const body = {
      error: { code: 'not_supported', message: 'x', details: { capability: 'flows' } },
    };
    expect(errorSchema.safeParse(body).success).toBe(true);
  });
});
