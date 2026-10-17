import { describe, expect, test } from 'bun:test';
import type { JobDetails, JobFailure } from '@qelay-cloud/store-postgres';
import { toJobWire } from '../src/jobs/model';

/** The panel's job inspector refuses a timeline of more than this many entries. */
const PANEL_TIMELINE_LIMIT = 20;

function failedJob(attempts: number): { job: JobDetails; failure: JobFailure } {
  const job = {
    id: 'j1',
    queue: 'q',
    name: 'n',
    state: 'failed',
    data: null,
    returnValue: null,
    failedReason: 'boom',
    priority: 0,
    createdAt: 1_000,
    runAt: 1_000,
    startedAt: 1_100,
    completedAt: 900_000,
    attempts,
    maxAttempts: attempts,
    progress: 0,
    progressMessage: null,
    version: 7,
    lease: null,
    options: {},
  } as unknown as JobDetails;
  const failure: JobFailure = {
    reason: 'explicit_fail',
    stack: null,
    stalls: 0,
    // The store keeps the newest 20 attempts at most.
    attempts: Array.from({ length: Math.min(attempts, 20) }, (_, index) => ({
      attempt: attempts - Math.min(attempts, 20) + index + 1,
      startedAt: 2_000 + index * 1_000,
      failedAt: 2_500 + index * 1_000,
      reason: 'explicit_fail' as const,
      error: `attempt ${index}`,
      durationMs: 500,
    })),
  };
  return { job, failure };
}

describe('jobs wire model timeline', () => {
  test('jobs timeline of a job with many failed attempts fits what the panel accepts', () => {
    const { job, failure } = failedJob(50);
    const wire = toJobWire(job, { payloadBytes: 1_024, failure });
    expect(wire.timeline!.length).toBeLessThanOrEqual(PANEL_TIMELINE_LIMIT);
  });

  test('jobs timeline keeps its creation and its end, and the newest failures between them', () => {
    const { job, failure } = failedJob(50);
    const timeline = toJobWire(job, { payloadBytes: 1_024, failure }).timeline!;
    expect(timeline[0]).toEqual({ state: 'created', timestamp: 1_000 });
    // The last failed attempt is the failure that ended the job, so no second 'failed' follows it.
    expect(timeline.at(-1)).toMatchObject({ state: 'failed', attempt: 50 });
    expect(timeline.at(-2)).toMatchObject({ state: 'failed', attempt: 49 });
    const times = timeline.map((entry) => entry.timestamp);
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  test('jobs timeline of a short history is whole', () => {
    const { job, failure } = failedJob(2);
    const timeline = toJobWire(job, { payloadBytes: 1_024, failure }).timeline!;
    expect(timeline.map((entry) => entry.state)).toEqual(['created', 'active', 'failed', 'failed']);
  });
});
