import type { JobFull, QueueSummaryFull } from '@/lib/bqTypes';
import { formatDateTime, formatNumber } from '@/lib/format';

// Tab order: the states people triage first, then the two rare ones. Also validates ?status=.
export const JOB_STATUSES = [
  'all',
  'waiting',
  'prioritized',
  'active',
  'delayed',
  'completed',
  'failed',
  'waiting-children',
  'paused',
] as const;
export type JobStatusFilter = (typeof JOB_STATUSES)[number];
export const JOBS_PAGE_SIZE = 25;

export const STATE_LABEL: Record<JobStatusFilter, string> = {
  all: 'All',
  waiting: 'Waiting',
  prioritized: 'Prioritized',
  active: 'Active',
  delayed: 'Delayed',
  completed: 'Completed',
  failed: 'Failed',
  'waiting-children': 'Flow-blocked',
  paused: 'Paused',
};

export function selectionLabel(visible: number, total: number): string {
  return visible === total
    ? `${total} selected`
    : `${visible} of ${total} selected match this filter`;
}

export function withoutActed(selected: Set<string>, actedIds: string[]): Set<string> {
  const next = new Set(selected);
  for (const id of actedIds) next.delete(id);
  return next;
}

type Counts = QueueSummaryFull['counts'];

/**
 * Jobs in a state, from `/queues/summary`. That endpoint does not count flow-blocked or
 * paused jobs, so those tabs have no number — and "All" is the sum of the six it does count.
 */
export function stateCount(counts: Counts | undefined, status: JobStatusFilter): number | null {
  if (!counts || status === 'waiting-children' || status === 'paused') return null;
  if (status !== 'all') return counts[status];
  return (
    counts.waiting +
    counts.prioritized +
    counts.active +
    counts.delayed +
    counts.completed +
    counts.failed
  );
}

/** "15 jobs in emails", "2 failed jobs in emails", or "Failed jobs in emails" when uncounted. */
export function jobsHeadline(queue: string, status: JobStatusFilter, count: number | null) {
  const state = status === 'all' ? '' : `${STATE_LABEL[status].toLowerCase()} `;
  if (count == null)
    return `${status === 'all' ? 'Jobs' : `${STATE_LABEL[status]} jobs`} in ${queue}`;
  return `${formatNumber(count)} ${state}${count === 1 ? 'job' : 'jobs'} in ${queue}`;
}

/** The ID with its last four characters split off, so the head can ellipsize but the tail stays. */
export function splitId(id: string): { head: string; tail: string } {
  return id.length > 4 ? { head: id.slice(0, -4), tail: id.slice(-4) } : { head: '', tail: id };
}

function scalars(value: unknown): string[] {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return [String(value)];
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return Object.values(value).flatMap((item) =>
      typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean'
        ? [String(item)]
        : []
    );
  }
  return [];
}

/** The second line of a job row: its name and the first two plain values of its payload. */
export function previewOf(job: JobFull): string {
  return [job.name, ...scalars(job.data).slice(0, 2)].filter(Boolean).join(' · ');
}

function dataText(job: JobFull): string {
  try {
    return JSON.stringify(job.data ?? '').toLowerCase();
  } catch {
    return '';
  }
}

/** Client-side filter over the loaded page: ID, name or payload. `term` is lower-case. */
export function matchesFilter(job: JobFull, term: string): boolean {
  return (
    job.id.toLowerCase().includes(term) ||
    !!job.name?.toLowerCase().includes(term) ||
    dataText(job).includes(term)
  );
}

export function attemptsLabel(job: JobFull): string {
  return `${job.attempts ?? 0} / ${job.maxAttempts ?? '—'}`;
}

const timeFmt = new Intl.DateTimeFormat('it-IT', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});
const dayTimeFmt = new Intl.DateTimeFormat('it-IT', {
  day: '2-digit',
  month: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

/** Time of day for today's jobs, day and time within the year, the full date beyond that. */
export function createdLabel(ts: number | undefined, now: number): string {
  const date = new Date(ts ?? Number.NaN);
  if (Number.isNaN(date.getTime())) return '—';
  const today = new Date(now);
  if (date.toDateString() === today.toDateString()) return timeFmt.format(date);
  return date.getFullYear() === today.getFullYear() ? dayTimeFmt.format(date) : formatDateTime(ts);
}

/** Footer line: "Showing 26–50 of 143", or without the total when it isn't reliable. */
export function footerLabel(o: {
  start: number;
  shown: number;
  onPage: number;
  total: number | null;
  searching: boolean;
}): string {
  if (o.searching) return `${o.shown} of ${o.onPage} on this page match`;
  if (o.onPage === 0) return 'No jobs on this page';
  const from = o.start + 1;
  const to = o.start + o.onPage;
  const range = from === to ? formatNumber(from) : `${formatNumber(from)}–${formatNumber(to)}`;
  return o.total != null && o.total >= to
    ? `Showing ${range} of ${formatNumber(o.total)}`
    : `Showing ${range}`;
}

/** What an empty table says, depending on why it is empty. */
export function emptyCopy(o: {
  search: string;
  queue: string;
  status: JobStatusFilter;
  discoveryError: boolean;
}): { title: string; hint: string } {
  if (o.search.trim()) {
    return {
      title: 'No matching jobs',
      hint: 'Nothing on this page matches your filter. The filter only searches the page you are on.',
    };
  }
  if (!o.queue) {
    return o.discoveryError
      ? { title: 'Queues unavailable', hint: 'Queue discovery failed. Retry above.' }
      : { title: 'Select a queue', hint: 'Choose a queue to list its jobs.' };
  }
  return {
    title:
      o.status === 'all'
        ? `No jobs in ${o.queue}`
        : `No ${STATE_LABEL[o.status].toLowerCase()} jobs in ${o.queue}`,
    hint: 'Jobs appear here while a worker is processing them.',
  };
}
