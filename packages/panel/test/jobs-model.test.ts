import { describe, expect, test } from 'bun:test';
import {
  attemptsLabel,
  createdLabel,
  emptyCopy,
  footerLabel,
  JOB_STATUSES,
  jobsHeadline,
  matchesFilter,
  previewOf,
  splitId,
  stateCount,
} from '../src/pages/control/jobsPro/model';

const counts = { waiting: 2, prioritized: 7, active: 0, completed: 4, failed: 2, delayed: 1 };

describe('Jobs state counts', () => {
  test('All sums the six counted states; flow-blocked and paused have no number', () => {
    expect(stateCount(counts, 'all')).toBe(16);
    expect(stateCount(counts, 'failed')).toBe(2);
    expect(stateCount(counts, 'waiting-children')).toBeNull();
    expect(stateCount(counts, 'paused')).toBeNull();
    expect(stateCount(undefined, 'all')).toBeNull();
  });

  test('every tab is a valid ?status= value, triaged states first', () => {
    expect(JOB_STATUSES.slice(0, 3)).toEqual(['all', 'waiting', 'prioritized']);
    expect(JOB_STATUSES.slice(-2)).toEqual(['waiting-children', 'paused']);
  });

  test('the headline names the state and pluralises', () => {
    expect(jobsHeadline('emails', 'all', 15)).toBe('15 jobs in emails');
    expect(jobsHeadline('emails', 'all', 1)).toBe('1 job in emails');
    expect(jobsHeadline('emails', 'failed', 2)).toBe('2 failed jobs in emails');
    expect(jobsHeadline('emails', 'waiting-children', null)).toBe('Flow-blocked jobs in emails');
    expect(jobsHeadline('emails', 'all', null)).toBe('Jobs in emails');
  });
});

describe('Jobs row helpers', () => {
  test('splitId keeps the last four characters whole for middle truncation', () => {
    expect(splitId('019f252b-86c0-7000-a54e-3816c968ebf0')).toEqual({
      head: '019f252b-86c0-7000-a54e-3816c968',
      tail: 'ebf0',
    });
    expect(splitId('abc')).toEqual({ head: '', tail: 'abc' });
    const { head, tail } = splitId('ui-cross-node-42');
    expect(head + tail).toBe('ui-cross-node-42');
  });

  test('the preview is the name plus the first two plain payload values', () => {
    expect(
      previewOf({
        id: 'a',
        name: 'send-email',
        data: { to: 'user1@example.com', subject: 'Welcome 1', extra: 3, nested: { a: 1 } },
      })
    ).toBe('send-email · user1@example.com · Welcome 1');
    expect(previewOf({ id: 'a', data: 'hello' })).toBe('hello');
    expect(previewOf({ id: 'a', data: [1, 2] })).toBe('');
    expect(previewOf({ id: 'a' })).toBe('');
  });

  test('the filter matches ID, name and payload, case-insensitively', () => {
    const job = { id: 'Job-7', name: 'Send-Email', data: { to: 'User@Example.com' } };
    expect(matchesFilter(job, 'job-7')).toBe(true);
    expect(matchesFilter(job, 'send-')).toBe(true);
    expect(matchesFilter(job, 'user@example')).toBe(true);
    expect(matchesFilter(job, 'nope')).toBe(false);
    expect(matchesFilter({ id: 'x' }, 'nope')).toBe(false);
  });

  test('attempts read "made / max" and tolerate a missing max', () => {
    expect(attemptsLabel({ id: 'a', attempts: 1, maxAttempts: 3 })).toBe('1 / 3');
    expect(attemptsLabel({ id: 'a' })).toBe('0 / —');
  });

  test('created shows the time today, day and time this year, the full date before that', () => {
    const now = new Date(2026, 9, 8, 12, 0, 0).getTime();
    const today = new Date(2026, 9, 8, 9, 5, 7).getTime();
    const earlier = new Date(2026, 6, 3, 9, 5, 7).getTime();
    const lastYear = new Date(2025, 6, 3, 9, 5, 7).getTime();
    expect(createdLabel(today, now)).toBe('09:05:07');
    expect(createdLabel(earlier, now)).toBe('03/07, 09:05:07');
    expect(createdLabel(lastYear, now)).toContain('2025');
    expect(createdLabel(undefined, now)).toBe('—');
  });
});

describe('Jobs footer and empty copy', () => {
  const base = { start: 0, shown: 11, onPage: 11, total: null, searching: false };

  test('the footer shows the range, with the total only when it is trustworthy', () => {
    expect(footerLabel({ ...base, total: 11 })).toBe('Showing 1–11 of 11');
    expect(footerLabel({ ...base, start: 25, onPage: 25, shown: 25 })).toBe('Showing 26–50');
    expect(footerLabel({ ...base, onPage: 1, shown: 1, total: 1 })).toBe('Showing 1 of 1');
    // A total below what is on screen is stale; drop it rather than print "of 3".
    expect(footerLabel({ ...base, total: 3 })).toBe('Showing 1–11');
    expect(footerLabel({ ...base, onPage: 0, shown: 0 })).toBe('No jobs on this page');
    expect(footerLabel({ ...base, shown: 2, searching: true })).toBe('2 of 11 on this page match');
  });

  test('empty copy depends on why the table is empty', () => {
    const o = { search: '', queue: 'emails', status: 'failed' as const, discoveryError: false };
    expect(emptyCopy(o).title).toBe('No failed jobs in emails');
    expect(emptyCopy({ ...o, status: 'all' }).title).toBe('No jobs in emails');
    expect(emptyCopy({ ...o, search: 'x' }).title).toBe('No matching jobs');
    expect(emptyCopy({ ...o, queue: '' }).title).toBe('Select a queue');
    expect(emptyCopy({ ...o, queue: '', discoveryError: true }).title).toBe('Queues unavailable');
  });
});
