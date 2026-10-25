import { describe, expect, test } from 'bun:test';
import { demoBackupPolicyReply } from '../src/lib/demo/backupPolicy';
import { parseBackupPolicy } from '../src/lib/ops/types';
import {
  type Draft,
  draftFrom,
  draftProblems,
  inputFrom,
  isChanged,
} from '../src/pages/control/backups/model';

const saved = {
  mechanism: 'external' as const,
  tool: 'pgBackRest',
  location: 'gs://b/p',
  updatedBy: 'ops',
  updatedAt: 1,
};
const draft = (patch: Partial<Draft>): Draft => ({
  mechanism: 'external',
  tool: 'pgBackRest',
  location: '',
  ...patch,
});

describe('the Backups draft', () => {
  test('an undeclared database starts with nothing picked, so it never saves by accident', () => {
    expect(draftFrom(null)).toEqual({ mechanism: null, tool: '', location: '' });
    expect(draftProblems(draftFrom(null))).toEqual({ mechanism: 'Pick one.' });
    expect(inputFrom(draftFrom(null))).toBeNull();
  });

  test('only "external" carries a tool, and the tool is required', () => {
    expect(draftProblems(draft({ tool: '  ' })).tool).toBeDefined();
    expect(draftProblems(draft({ mechanism: 'none', tool: '  ' }))).toEqual({});
    expect(inputFrom(draft({ mechanism: 'none', tool: 'leftover', location: 'x' }))).toEqual({
      mechanism: 'none',
    });
    expect(inputFrom(draft({ tool: ' WAL-G ', location: ' ' }))).toEqual({
      mechanism: 'external',
      tool: 'WAL-G',
      location: null,
    });
  });

  test('the server’s bounds are enforced on the trimmed text', () => {
    expect(draftProblems(draft({ tool: ` ${'x'.repeat(200)} ` }))).toEqual({});
    expect(draftProblems(draft({ tool: 'x'.repeat(201) })).tool).toBeDefined();
    expect(draftProblems(draft({ location: 'x'.repeat(501) })).location).toBeDefined();
  });

  test('a save is offered only when it would change what the server holds', () => {
    expect(isChanged(draftFrom(saved), saved)).toBe(false);
    expect(isChanged(draft({ tool: 'pgBackRest', location: 'gs://b/p' }), saved)).toBe(false);
    expect(isChanged(draft({ location: '' }), saved)).toBe(true);
    expect(isChanged(draft({ mechanism: 'provider' }), saved)).toBe(true);
    expect(isChanged(draft({ mechanism: 'none' }), null)).toBe(true);
  });
});

describe('the Backups wire and demo', () => {
  test('parseBackupPolicy reads a declared policy and an undeclared one', () => {
    expect(parseBackupPolicy({ ok: true, data: { policy: saved } })).toEqual(saved);
    expect(parseBackupPolicy({ ok: true, data: { policy: null } })).toBeNull();
  });

  test('parseBackupPolicy refuses a mechanism the panel does not know', () => {
    const body = { ok: true, data: { policy: { ...saved, mechanism: 'tape' } } };
    expect(() => parseBackupPolicy(body)).toThrow();
  });

  test('the demo answers like the server: it keeps a valid save and refuses one that does not fit', () => {
    const refused = demoBackupPolicyReply('PUT', { mechanism: 'external' });
    expect(refused.status).toBe(400);
    expect(demoBackupPolicyReply('PUT', { mechanism: 'none', tool: 'x' }).status).toBe(400);

    const kept = demoBackupPolicyReply('PUT', { mechanism: 'provider' });
    expect(kept.status).toBe(200);
    const read = demoBackupPolicyReply('GET', undefined).body as { data: { policy: unknown } };
    expect(read.data.policy).toMatchObject({ mechanism: 'provider', tool: null, location: null });
  });
});
