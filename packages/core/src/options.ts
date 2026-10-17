import { UnsupportedOptionError } from './errors';
import type { JobOptions } from './jobs';

/** Upstream options that v1.0.0 does not take (D6). */
const UNSUPPORTED = new Set([
  'repeat',
  'debounce',
  'durable',
  'stackTraceLimit',
  'keepLogs',
  'sizeLimit',
  'timestamp',
]);

/** Options that only mean something inside a flow, so a plain add refuses them. */
const FLOW_ONLY = new Set([
  'parent',
  'failParentOnFailure',
  'removeDependencyOnFailure',
  'continueParentOnFailure',
  'ignoreDependencyOnFailure',
]);

const SUPPORTED = new Set([
  'priority',
  'lifo',
  'delay',
  'attempts',
  'backoff',
  'timeout',
  'stallTimeout',
  'jobId',
  'deduplication',
  'group',
  'removeOnComplete',
  'removeOnFail',
]);

const MAX_DELAY_MS = 365 * 24 * 60 * 60 * 1000;
const MAX_BACKOFF_DELAY_MS = 86_400_000;

function integer(name: string, value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): void {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new UnsupportedOptionError(name, `must be an integer from ${min} to ${max}`);
  }
}

function boolean(name: string, value: unknown): void {
  if (typeof value !== 'boolean') {
    throw new UnsupportedOptionError(
      name,
      'must be a boolean (age and count retention is unsupported)'
    );
  }
}

/**
 * Throws `UnsupportedOptionError` for an option outside the supported subset, or with an invalid
 * value. Returns the options unchanged so a caller can validate inline. A negative `delay` is
 * accepted and read as 0, as upstream does.
 */
export function validateJobOptions(options: JobOptions = {}): JobOptions {
  for (const key of Object.keys(options)) {
    if (SUPPORTED.has(key)) continue;
    if (FLOW_ONLY.has(key)) {
      throw new UnsupportedOptionError(
        key,
        'belongs to a flow: add the job as a child through FlowProducer, which sets its parent'
      );
    }
    throw new UnsupportedOptionError(
      key,
      UNSUPPORTED.has(key) ? 'is not supported in v1.0.0' : 'is unknown'
    );
  }
  if (options.priority !== undefined) integer('priority', options.priority, 0);
  if (options.delay !== undefined) {
    if (typeof options.delay !== 'number' || !Number.isFinite(options.delay)) {
      throw new UnsupportedOptionError('delay', 'must be a finite number');
    }
    if (options.delay > MAX_DELAY_MS) throw new UnsupportedOptionError('delay', 'is over 365 days');
  }
  if (options.attempts !== undefined) integer('attempts', options.attempts, 1);
  if (options.timeout !== undefined) integer('timeout', options.timeout, 1);
  if (options.stallTimeout !== undefined) integer('stallTimeout', options.stallTimeout, 1);
  if (options.lifo !== undefined) boolean('lifo', options.lifo);
  if (options.removeOnComplete !== undefined) boolean('removeOnComplete', options.removeOnComplete);
  if (options.removeOnFail !== undefined) boolean('removeOnFail', options.removeOnFail);
  if (options.jobId !== undefined && (typeof options.jobId !== 'string' || options.jobId === '')) {
    throw new UnsupportedOptionError('jobId', 'must be a non-empty string');
  }
  const { backoff, deduplication, group } = options;
  if (typeof backoff === 'number') integer('backoff', backoff, 0);
  else if (backoff !== undefined) {
    if (backoff.type !== 'fixed' && backoff.type !== 'exponential') {
      throw new UnsupportedOptionError('backoff.type', 'must be "fixed" or "exponential"');
    }
    integer('backoff.delay', backoff.delay, 0);
    if (backoff.maxDelay !== undefined) {
      integer('backoff.maxDelay', backoff.maxDelay, 0, MAX_BACKOFF_DELAY_MS);
    }
  }
  if (deduplication !== undefined) {
    if (typeof deduplication.id !== 'string' || deduplication.id === '') {
      throw new UnsupportedOptionError('deduplication.id', 'must be a non-empty string');
    }
    if (deduplication.ttl !== undefined) integer('deduplication.ttl', deduplication.ttl, 1);
  }
  if (group !== undefined) {
    if (group.maxSize !== undefined) integer('group.maxSize', group.maxSize, 1);
    if (group.priority !== undefined) integer('group.priority', group.priority, 0, 2_097_151);
  }
  return options;
}
