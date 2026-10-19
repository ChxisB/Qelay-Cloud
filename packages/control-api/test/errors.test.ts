import { describe, expect, test } from 'bun:test';
import {
  FlowError,
  FlowProtectedError,
  IllegalTransitionError,
  JobNotFoundError,
  JobStateError,
  JobVersionError,
  LeaseLostError,
  OperationDeadlineError,
  StoreOverloadedError,
  OutcomeUnknownError,
  QueuePausedError,
  StoreError,
  TransportError,
  UnsupportedOptionError,
} from '@qelay-cloud/core';
import {
  BatchTooLargeError,
  GroupFullError,
  PayloadTooComplexError,
  PayloadTooLargeError,
} from '@qelay-cloud/store-postgres';
import { ApiError, errorBody, toApiError } from '../src';
import { bodyOf, errorOf, harness } from './support';
import type { ErrorShape } from './support';

const SQL_TEXT = "SELECT payload, secret FROM qcloud_jobs WHERE id = $1 AND token = 'hunter2'";

describe('toApiError', () => {
  const driverCause = new Error(SQL_TEXT);
  const cases: Array<[string, unknown, number, string]> = [
    ['JOB_NOT_FOUND', new JobNotFoundError('j1'), 404, 'job_not_found'],
    ['JOB_STATE (exists)', new JobStateError('j1', 'active', 'removed'), 409, 'job_state'],
    ['JOB_STATE (missing)', new JobStateError('j1', null, 'removed'), 404, 'job_not_found'],
    ['LEASE_LOST', new LeaseLostError('j1'), 409, 'lease_lost'],
    ['QUEUE_PAUSED', new QueuePausedError('q'), 409, 'queue_paused'],
    [
      'ILLEGAL_TRANSITION',
      new IllegalTransitionError('x', 'waiting', 'completed'),
      409,
      'illegal_transition',
    ],
    ['FLOW_PROTECTED', new FlowProtectedError('job j1', SQL_TEXT), 409, 'flow_protected'],
    ['FLOW_INVALID', new FlowError('a flow has at most 1000 jobs'), 400, 'flow_invalid'],
    ['JOB_VERSION', new JobVersionError('j1', 3, 5), 409, 'version_conflict'],
    [
      'PAYLOAD_TOO_LARGE',
      new PayloadTooLargeError(2_000_000, 1_000_000, 0),
      413,
      'payload_too_large',
    ],
    [
      'PAYLOAD_TOO_COMPLEX',
      new PayloadTooComplexError('nodes', 20_000, 0),
      413,
      'payload_too_large',
    ],
    ['BATCH_TOO_LARGE', new BatchTooLargeError(5_000, 1_000), 400, 'batch_too_large'],
    ['GROUP_FULL', new GroupFullError('q', 'g1', 10, 0), 409, 'group_full'],
    ['UNSUPPORTED_OPTION', new UnsupportedOptionError('lifo'), 400, 'unsupported_option'],
    [
      'TRANSPORT_ERROR',
      new TransportError(SQL_TEXT, { cause: driverCause }),
      502,
      'transport_error',
    ],
    ['STORE_ERROR', new StoreError(SQL_TEXT, { cause: driverCause }), 503, 'store_error'],
    ['STORE_OVERLOADED', new StoreOverloadedError('claim', 128), 503, 'store_overloaded'],
    ['OPERATION_DEADLINE', new OperationDeadlineError('claim', 5000), 504, 'operation_deadline'],
    [
      'OUTCOME_UNKNOWN',
      new OutcomeUnknownError('j1', 'complete', driverCause),
      504,
      'outcome_unknown',
    ],
    ['an unknown Error', driverCause, 500, 'internal_error'],
    ['a thrown string', SQL_TEXT, 500, 'internal_error'],
    ['null', null, 500, 'internal_error'],
  ];

  test.each(cases)('%s maps to %d %s', (_name, error, status, code) => {
    const mapped = toApiError(error, 'req-12345678');
    expect([mapped.status, mapped.code]).toEqual([status, code]);
    const text = JSON.stringify(errorBody(mapped));
    expect(text).not.toContain('SELECT');
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain('qcloud_jobs');
  });

  test('an unexpected failure carries only the request id', () => {
    const mapped = toApiError(new Error('boom'), 'req-12345678');
    expect(errorBody(mapped)).toEqual({
      error: {
        code: 'internal_error',
        message: 'internal error',
        details: { requestId: 'req-12345678' },
      },
    });
  });

  test('a job id is passed through as a detail, and a state that makes the action impossible is named', () => {
    expect(
      errorBody(toApiError(new JobStateError('j7', 'active', 'removed'), 'r')).error.details
    ).toEqual({
      jobId: 'j7',
      state: 'active',
    });
  });

  test('a version conflict names the job and both versions so the caller can read it again', () => {
    expect(errorBody(toApiError(new JobVersionError('j7', 3, 5), 'r')).error.details).toEqual({
      jobId: 'j7',
      expectedVersion: 3,
      actualVersion: 5,
    });
  });

  test('a payload over the limit names the limit and not the size of what was sent', () => {
    expect(
      errorBody(toApiError(new PayloadTooLargeError(2_000_000, 1_000_000, 4), 'r')).error.details
    ).toEqual({ maxBytes: 1_000_000, index: 4 });
  });

  test('an ApiError is returned as it is', () => {
    const error = ApiError.notSupported('flows', 'flows are not available');
    expect(toApiError(error, 'r')).toBe(error);
    expect(errorBody(error)).toEqual({
      error: {
        code: 'not_supported',
        message: 'flows are not available',
        details: { capability: 'flows' },
      },
    });
  });
});

describe('a forced failure through the service', () => {
  const failing = (error: unknown) =>
    harness(
      {},
      {
        routes: [
          {
            method: 'GET',
            path: '/test/boom',
            access: 'read',
            handle: () => {
              throw error;
            },
          },
          {
            method: 'GET',
            path: '/test/reject',
            access: 'read',
            handle: async () => {
              await Promise.resolve();
              throw error;
            },
          },
        ],
      }
    );

  for (const path of ['/test/boom', '/test/reject']) {
    test(`${path}: no stack trace, no SQL, no cause in the body or the log`, async () => {
      const cause = new Error(SQL_TEXT);
      const api = failing(new Error(SQL_TEXT, { cause }));
      const response = await api.call('GET', path);
      expect(response.status).toBe(500);
      const text = await response.text();
      for (const forbidden of [
        'SELECT',
        'hunter2',
        'qcloud_jobs',
        ' at ',
        '.ts:',
        'stack',
        'node_modules',
      ]) {
        expect(text).not.toContain(forbidden);
      }
      const body = JSON.parse(text) as ErrorShape;
      expect(body.error.code).toBe('internal_error');
      expect(body.error.details?.requestId).toBe(response.headers.get('x-request-id') as string);
      const logged = JSON.stringify([api.recorded.requests, api.recorded.errors]);
      expect(logged).not.toContain('SELECT');
      expect(logged).not.toContain('hunter2');
      expect(api.recorded.errors).toHaveLength(1);
      expect(api.recorded.errors[0]?.fields).toMatchObject({
        code: 'internal_error',
        errorType: 'Error',
      });
    });
  }

  test('a database error code reaches the log, and the message does not', async () => {
    const pg = Object.assign(new Error(SQL_TEXT), { name: 'PostgresError', code: '23505' });
    const api = failing(pg);
    await api.call('GET', '/test/boom');
    expect(api.recorded.errors[0]?.fields).toMatchObject({
      errorType: 'PostgresError',
      errorCode: '23505',
    });
    expect(JSON.stringify(api.recorded.errors)).not.toContain('SELECT');
  });

  test('a typed core error is answered with its mapped status', async () => {
    const api = failing(new JobStateError('j1', 'active', 'removed'));
    const response = await api.call('GET', '/test/boom');
    expect(response.status).toBe(409);
    expect((await errorOf(response)).error.code).toBe('job_state');
    expect(api.recorded.errors).toHaveLength(0);
  });

  test('a store failure is a 503 that names no table', async () => {
    const api = failing(
      new StoreError(SQL_TEXT, { cause: new Error('connection refused 10.0.0.5:5432') })
    );
    const response = await api.call('GET', '/test/boom');
    expect(response.status).toBe(503);
    const text = await response.text();
    expect(text).not.toContain('10.0.0.5');
    expect(text).not.toContain('qcloud_jobs');
    expect(api.recorded.errors).toHaveLength(1);
  });

  test('error bodies are JSON with a request id header', async () => {
    const response = await harness().call('GET', '/test/missing');
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(response.headers.get('x-request-id')).toBeTruthy();
    expect(Object.keys(await bodyOf(response))).toEqual(['error']);
  });
});
