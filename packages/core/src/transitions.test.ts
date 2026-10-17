import { describe, expect, test } from 'bun:test';
import { IllegalTransitionError } from './errors';
import { JOB_STATES } from './jobs';
import type { JobState } from './jobs';
import {
  TRANSITIONS,
  allows,
  assertTransition,
  isClaimable,
  isLegalMove,
  isTerminal,
} from './transitions';
import type { Cause, TransitionTarget } from './transitions';

const TARGETS: readonly TransitionTarget[] = [...JOB_STATES, 'removed'];

describe('transition table', () => {
  test('every cause appears once', () => {
    const causes = TRANSITIONS.map((t) => t.cause);
    expect(new Set(causes).size).toBe(causes.length);
  });

  test('every legal (cause, from, to) is accepted and every other triple is refused', () => {
    let legal = 0;
    let illegal = 0;
    for (const { cause } of TRANSITIONS) {
      for (const from of JOB_STATES) {
        for (const to of TARGETS) {
          const expected = TRANSITIONS.some(
            (t) => t.cause === cause && t.from.includes(from) && t.to.includes(to)
          );
          if (expected) {
            expect(() => assertTransition(cause, from, to)).not.toThrow();
            legal += 1;
          } else {
            expect(() => assertTransition(cause, from, to)).toThrow(IllegalTransitionError);
            illegal += 1;
          }
        }
      }
    }
    expect(legal).toBeGreaterThan(30);
    expect(illegal).toBeGreaterThan(legal);
  });

  test('a finished job only leaves by retiring or by a DLQ retry', () => {
    for (const state of ['completed', 'failed'] as const) {
      const causes = TRANSITIONS.filter((t) => t.from.includes(state)).map((t) => t.cause);
      const allowed: Cause[] = state === 'failed' ? ['retire', 'retry-dlq'] : ['retire'];
      expect(causes.sort()).toEqual(allowed.sort());
    }
  });

  test('only a ready job can be claimed, and only an active job completes', () => {
    const claimable = JOB_STATES.filter((s) => isClaimable(s));
    expect(claimable.sort()).toEqual(['prioritized', 'waiting']);
    const completable = JOB_STATES.filter((s) => allows('complete', s));
    expect(completable).toEqual(['active']);
  });

  test('a claim cannot reach any state but active', () => {
    for (const from of JOB_STATES) {
      for (const to of JOB_STATES) {
        if (to === 'active') continue;
        expect(() => assertTransition('claim', from, to)).toThrow();
      }
    }
  });

  test('isLegalMove: a no-op is legal, active cannot go back to delayed by a claim', () => {
    for (const state of JOB_STATES) expect(isLegalMove(state, state)).toBe(true);
    expect(isLegalMove('completed', 'active')).toBe(false);
    expect(isLegalMove('completed', 'waiting')).toBe(false);
    expect(isLegalMove('waiting', 'completed')).toBe(false);
    expect(isLegalMove('waiting', 'active')).toBe(true);
  });

  test('isTerminal', () => {
    const terminal = JOB_STATES.filter((s: JobState) => isTerminal(s));
    expect(terminal).toEqual(['completed', 'failed']);
  });

  test('the error names the cause and both states', () => {
    try {
      assertTransition('claim', 'completed', 'active');
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(IllegalTransitionError);
      expect((error as IllegalTransitionError).code).toBe('ILLEGAL_TRANSITION');
      expect((error as Error).message).toContain('completed -> active by claim');
    }
  });
});
