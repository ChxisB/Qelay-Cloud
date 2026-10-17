import type { Json } from './shared';

/**
 * The Transport and Deployment pages in demo mode: a healthy local deployment with one queue that
 * is catching up. Times are relative to now so the "age" labels read as live; nothing is random.
 */

const MINUTE = 60_000;

function transport(now: number): Json {
  const exact = { observedAt: now, ageMs: 0, maxStalenessMs: 0, source: 'memory' };
  const row = (queue: string, claimable: number, notRung: number, reRingDue: number): Json => ({
    queue,
    doorbellDepth: claimable,
    inFlight: null,
    delayed: null,
    oldestUndeliveredAgeMs: claimable > 0 ? 4_000 : null,
    deadLetterDepth: null,
    deadLetterOldestAgeMs: null,
    freshness: exact,
    store: {
      queue,
      claimable,
      notRung,
      reRingDue,
      oldestNotRungAgeMs: notRung > 0 ? 1_500 : null,
      paused: false,
      capped: false,
    },
  });
  return {
    ok: true,
    transport: {
      name: 'local',
      maxDeliverDelayMs: null,
      ordering: 'best-effort',
      approximateCounts: false,
    },
    deadLetter: { supported: false },
    queues: [row('emails', 12, 0, 3), row('reports', 0, 0, 0), row('webhooks', 2, 1, 0)],
    truncated: false,
    timestamp: now,
  };
}

function deployment(now: number): Json {
  return {
    ok: true,
    version: 'demo',
    commit: null,
    production: false,
    devToken: false,
    schema: { current: 5, expected: 5, state: 'current' },
    database: { state: 'ok', latencyMs: 2 },
    transport: { name: 'local', state: 'ok' },
    connections: { inUse: 6, maxConnections: 100, needed: null, mode: null },
    tick: {
      state: 'ok',
      lastSuccessAt: now - 8_000,
      lastFailureAt: null,
      ageMs: 8_000,
      lateAfterMs: MINUTE,
      staleAfterMs: 5 * MINUTE,
    },
    workers: { total: 3, active: 2 },
    doorbells: { notRung: 1, oldestNotRungAgeMs: 1_500, queuesScanned: 3, partial: false },
    warnings: [],
    timestamp: now,
  };
}

/** `GET /transport`, `/transport/dead-letters` and `/deployment` for the demo dispatcher. */
export function demoOpsResponse(segments: string[], now = Date.now()): Json | null {
  if (segments[0] === 'deployment' && segments.length === 1) return deployment(now);
  if (segments[0] !== 'transport') return null;
  if (segments.length === 1) return transport(now);
  if (segments[1] === 'dead-letters') {
    return {
      ok: true,
      queue: '',
      available: false,
      reason: 'not_supported',
      items: [],
      timestamp: now,
    };
  }
  return null;
}
