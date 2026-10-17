// Copy of the validation of a job response in the panel's job inspector (MIT, see docs/PORTING.md),
// so a contract test can run what the inspector runs on what the Control API sends for `GET
// /jobs/:id`, `GET /jobs/custom/:id` and `GET /jobs/:id/result`. Do not edit; deleted when task 33
// exists.
//
//   file:          src/pages/control/jobInspector/jobValidation.ts of ../qelay-control-panel
//   panel commit:  8ebf9328950a23a2f2687115a0ec15e66b7659bd (working tree, two comments renamed)
//   sha256 of the whole file: 18f219b9963b0cd49fcc68d207c0f138d5cac01e9d8f9ed0e2fa3c95bc83ed6c
//   copied lines:  15-84 and 130-251 (the stack preview of lines 86-128 is display only)
//   changed:       `BqError` is declared below instead of imported from '@/lib/bq'.
import type { JobFull } from './panel-bq-types';

const MAX_UPSTREAM_STACKTRACE_LINES = 10_000;

export class BqError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

function invalidJobEnvelope(reason: string): never {
  throw new BqError(`Invalid job response: ${reason}`, 200);
}

function validateOptionalString(
  job: Record<string, unknown>,
  field: string,
  { nullable = false, nonEmpty = false }: { nullable?: boolean; nonEmpty?: boolean } = {},
  path = 'job'
): void {
  if (!Object.hasOwn(job, field) || job[field] === undefined) return;
  const value = job[field];
  if (nullable && value === null) return;
  if (typeof value !== 'string' || (nonEmpty && !value.trim())) {
    invalidJobEnvelope(
      `${path}.${field} must be ${nullable ? 'a string or null' : 'a string'}${nonEmpty ? ' (non-empty)' : ''}`
    );
  }
}

function validateOptionalNumber(
  job: Record<string, unknown>,
  field: string,
  {
    nullable = false,
    integer = false,
    min,
    max,
  }: { nullable?: boolean; integer?: boolean; min?: number; max?: number } = {},
  path = 'job'
): void {
  if (!Object.hasOwn(job, field) || job[field] === undefined) return;
  const value = job[field];
  if (nullable && value === null) return;
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    (integer && !Number.isSafeInteger(value)) ||
    (min !== undefined && value < min) ||
    (max !== undefined && value > max)
  ) {
    invalidJobEnvelope(
      `${path}.${field} must be a valid${integer ? ' safe integer' : ' finite number'}`
    );
  }
}

function validateOptionalBoolean(job: Record<string, unknown>, field: string): void {
  if (Object.hasOwn(job, field) && job[field] !== undefined && typeof job[field] !== 'boolean') {
    invalidJobEnvelope(`job.${field} must be a boolean`);
  }
}

function validateStringArray(
  job: Record<string, unknown>,
  field: string,
  { nullable = false, nonEmpty = false }: { nullable?: boolean; nonEmpty?: boolean } = {}
): void {
  if (!Object.hasOwn(job, field) || job[field] === undefined) return;
  const value = job[field];
  if (nullable && value === null) return;
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== 'string' || (nonEmpty && !entry.trim()))
  ) {
    invalidJobEnvelope(
      `job.${field} must be ${nullable ? 'a string array or null' : 'a string array'}`
    );
  }
}

/** Validate every structured value consumed by the inspector and its child panels. */
function validateRenderableJob(job: Record<string, unknown>, canonical: boolean): void {
  if (canonical && (typeof job.state !== 'string' || !job.state.trim())) {
    invalidJobEnvelope('canonical job.state must be a non-empty string');
  }
  validateOptionalString(job, 'state', { nonEmpty: true });
  validateOptionalString(job, 'name', { nonEmpty: true });
  validateOptionalString(job, 'failedReason');
  if (canonical && (typeof job.queue !== 'string' || !job.queue.trim())) {
    invalidJobEnvelope('canonical job.queue must be a non-empty string');
  }
  validateOptionalString(job, 'queue', { nonEmpty: true });
  validateOptionalString(job, 'customId', { nullable: true });
  validateOptionalString(job, 'parentId', { nullable: true, nonEmpty: true });
  validateOptionalString(job, 'groupId', { nullable: true });
  validateOptionalString(job, 'progressMessage', { nullable: true });

  validateStringArray(job, 'childrenIds', { nonEmpty: true });
  validateStringArray(job, 'dependsOn', { nonEmpty: true });
  validateStringArray(job, 'tags');
  validateStringArray(job, 'stacktrace', { nullable: true });
  if (Array.isArray(job.stacktrace) && job.stacktrace.length > MAX_UPSTREAM_STACKTRACE_LINES) {
    invalidJobEnvelope(
      `job.stacktrace exceeds Qelay's ${MAX_UPSTREAM_STACKTRACE_LINES}-entry limit`
    );
  }

  validateOptionalNumber(job, 'priority', { integer: true });
  validateOptionalNumber(job, 'createdAt');
  validateOptionalNumber(job, 'runAt');
  validateOptionalNumber(job, 'startedAt', { nullable: true });
  validateOptionalNumber(job, 'completedAt', { nullable: true });
  validateOptionalNumber(job, 'attempts', { integer: true, min: 0 });
  validateOptionalNumber(job, 'maxAttempts', { integer: true, min: 0 });
  validateOptionalNumber(job, 'backoff', { integer: true, min: 0 });
  validateOptionalNumber(job, 'timeout', { nullable: true, integer: true, min: 0 });
  validateOptionalNumber(job, 'ttl', { nullable: true, integer: true, min: 0 });
  validateOptionalNumber(job, 'progress', { min: 0, max: 100 });
  validateOptionalNumber(job, 'lastHeartbeat');
  validateOptionalNumber(job, 'stallCount', { integer: true, min: 0 });
  validateOptionalBoolean(job, 'removeOnComplete');
  validateOptionalBoolean(job, 'removeOnFail');

  if (Object.hasOwn(job, 'backoffConfig') && job.backoffConfig !== undefined) {
    const config = job.backoffConfig;
    if (config !== null) {
      if (!config || typeof config !== 'object' || Array.isArray(config)) {
        invalidJobEnvelope('job.backoffConfig must be an object or null');
      }
      const raw = config as Record<string, unknown>;
      if (raw.type !== 'fixed' && raw.type !== 'exponential') {
        invalidJobEnvelope('job.backoffConfig.type must be fixed or exponential');
      }
      validateOptionalNumber(raw, 'delay', { integer: true, min: 0 }, 'job.backoffConfig');
      if (!Object.hasOwn(raw, 'delay') || raw.delay === undefined) {
        invalidJobEnvelope('job.backoffConfig.delay is required');
      }
      validateOptionalNumber(raw, 'maxDelay', { integer: true, min: 0 }, 'job.backoffConfig');
    }
  }

  if (Object.hasOwn(job, 'timeline') && job.timeline !== undefined) {
    if (!Array.isArray(job.timeline)) invalidJobEnvelope('job.timeline must be an array');
    if (job.timeline.length > 20) invalidJobEnvelope('job.timeline exceeds 20 entries');
    for (const [index, entry] of job.timeline.entries()) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        invalidJobEnvelope(`job.timeline[${index}] must be an object`);
      }
      const raw = entry as Record<string, unknown>;
      if (typeof raw.state !== 'string' || !raw.state.trim()) {
        invalidJobEnvelope(`job.timeline[${index}].state must be a non-empty string`);
      }
      if (typeof raw.timestamp !== 'number' || !Number.isFinite(raw.timestamp)) {
        invalidJobEnvelope(`job.timeline[${index}].timestamp must be a finite number`);
      }
      const entryPath = `job.timeline[${index}]`;
      validateOptionalString(raw, 'worker', {}, entryPath);
      validateOptionalString(raw, 'error', {}, entryPath);
      validateOptionalNumber(raw, 'attempt', { integer: true, min: 0 }, entryPath);
    }
  }
}

export function jobFromEnvelope(
  value: unknown,
  { canonical, expectedId }: { canonical: boolean; expectedId?: string }
): JobFull | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return invalidJobEnvelope('expected an object envelope');
  }
  const envelope = value as { ok?: unknown; job?: unknown };
  if (envelope.ok !== true || !Object.hasOwn(envelope, 'job')) {
    return invalidJobEnvelope('expected { ok: true, job }');
  }
  if (envelope.job === null) return null;
  if (!envelope.job || typeof envelope.job !== 'object' || Array.isArray(envelope.job)) {
    return invalidJobEnvelope('job must be an object or null');
  }

  const rawJob = envelope.job as Record<string, unknown>;
  if (typeof rawJob.id !== 'string' || !rawJob.id.trim()) {
    return invalidJobEnvelope('job.id must be a non-empty string');
  }
  if (expectedId !== undefined && rawJob.id !== expectedId) {
    return invalidJobEnvelope(`expected job.id ${JSON.stringify(expectedId)}`);
  }
  validateRenderableJob(rawJob, canonical);
  return rawJob as JobFull;
}

export function resultFromEnvelope(value: unknown, expectedId: string): { result: unknown } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BqError('Invalid job result response: expected an object envelope', 200);
  }
  const envelope = value as { ok?: unknown; id?: unknown; result?: unknown };
  if (envelope.ok !== true || envelope.id !== expectedId) {
    throw new BqError('Invalid job result response: expected { ok: true, id, result? }', 200);
  }
  // Qelay omits `result` when its value is undefined. The verified id is
  // therefore the presence marker that distinguishes a valid empty result.
  return { result: envelope.result };
}
