import { describe, expect, test } from 'bun:test';
import {
  errorInfoFrom,
  isForbidden,
  isNotSupported,
  isVersionConflict,
} from '../src/lib/errorBody';

describe('errorInfoFrom', () => {
  test('the Control API body: the message is text, never "[object Object]"', () => {
    const info = errorInfoFrom(
      {
        error: { code: 'job_state', message: 'the job is completed, so the action does not apply' },
      },
      409
    );
    expect(info.code).toBe('job_state');
    expect(info.message).toBe('The job is completed, so the action does not apply.');
    expect(info.message).not.toContain('[object');
  });

  test('details travel with the error', () => {
    const info = errorInfoFrom(
      {
        error: {
          code: 'version_conflict',
          message: 'the job changed since it was read, so nothing was changed',
          details: { jobId: 'j1', expectedVersion: 1, actualVersion: 2 },
        },
      },
      409
    );
    expect(info.details).toEqual({ jobId: 'j1', expectedVersion: 1, actualVersion: 2 });
  });

  test('403 says the role may not do it', () => {
    const info = errorInfoFrom(
      { error: { code: 'forbidden', message: 'this action needs the operator role' } },
      403
    );
    expect(info.message).toBe(
      'You do not have permission to do this. This action needs the operator role.'
    );
  });

  test('409 version_conflict asks for a reload', () => {
    const info = errorInfoFrom(
      { error: { code: 'version_conflict', message: 'the job changed since it was read' } },
      409
    );
    expect(info.message).toBe(
      'This job changed since it was loaded, so nothing was changed. Reload it and try again.'
    );
  });

  test('501 reads as a neutral "not available", not a failure', () => {
    const info = errorInfoFrom(
      { error: { code: 'not_supported', message: 'retrying a failed job is not available here' } },
      501
    );
    expect(info.message).toBe(
      'Not available in this deployment. Retrying a failed job is not available here.'
    );
  });

  test('a legacy string error is used as it is', () => {
    expect(errorInfoFrom({ ok: false, error: 'Queue not found' }, 200)).toEqual({
      message: 'Queue not found',
    });
  });

  test('anything else falls back to the status', () => {
    expect(errorInfoFrom(undefined, 502)).toEqual({ message: 'HTTP 502' });
    expect(errorInfoFrom('<html>', 500)).toEqual({ message: 'HTTP 500' });
    expect(errorInfoFrom({ error: { code: 7 } }, 500)).toEqual({ message: 'HTTP 500' });
  });
});

describe('error predicates', () => {
  const coded = (status: number, code: string) => Object.assign(new Error('x'), { status, code });

  test('they read the status and the code of any error that carries them', () => {
    expect(isNotSupported(coded(501, 'not_supported'))).toBe(true);
    expect(isNotSupported(coded(501, 'other'))).toBe(true);
    expect(isNotSupported(coded(409, 'not_supported'))).toBe(false);
    expect(isVersionConflict(coded(409, 'version_conflict'))).toBe(true);
    expect(isVersionConflict(coded(409, 'job_state'))).toBe(false);
    expect(isForbidden(coded(403, 'forbidden'))).toBe(true);
    expect(isForbidden(new Error('x'))).toBe(false);
    expect(isForbidden(null)).toBe(false);
  });
});
