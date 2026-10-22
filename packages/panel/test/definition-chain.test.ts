import { describe, expect, test } from 'bun:test';
import {
  CHAIN_GAP,
  CHAIN_NODE_WIDTH,
  isRollingBack,
  nodeMark,
  recordedFor,
  returnPath,
} from '../src/features/workflows/domain/definitionChain';
import type { WorkflowStep } from '../src/features/workflows/domain/workflowWire';

const step = (name: string): WorkflowStep => ({
  name,
  status: 'completed',
  attempts: 1,
  startedAt: 1,
  completedAt: 2,
  durationMs: 1,
  compensatable: false,
  error: null,
  childExecutionId: null,
  compensation: null,
  loopIndex: null,
});
const node = (name: string) => ({ type: 'step', step: { name } });

describe('nodeMark', () => {
  test('a finished run has done every node', () => {
    expect([0, 1, 2].map((i) => nodeMark(i, 3, 'completed'))).toEqual(['done', 'done', 'done']);
  });

  test('a run going forward has done what is before its cursor', () => {
    for (const state of ['running', 'waiting']) {
      expect([0, 1, 2].map((i) => nodeMark(i, 1, state))).toEqual(['done', 'current', 'ahead']);
    }
  });

  test('a run rolling back marks only its cursor, and a failed run marks nothing', () => {
    for (const state of ['compensating', 'compensation-stuck']) {
      expect([0, 1, 2].map((i) => nodeMark(i, 1, state))).toEqual([null, 'current', null]);
    }
    expect([0, 1].map((i) => nodeMark(i, 0, 'failed'))).toEqual([null, null]);
    expect(isRollingBack('compensating') && isRollingBack('compensation-stuck')).toBe(true);
    expect(isRollingBack('failed')).toBe(false);
  });
});

describe('returnPath', () => {
  test('there is nothing to go back over from the first node', () => {
    expect(returnPath(0)).toBeNull();
  });

  test('it starts at the middle of the current box and ends at the middle of the first', () => {
    const path = returnPath(2);
    const pitch = CHAIN_NODE_WIDTH + CHAIN_GAP;
    expect(path?.width).toBe(2 * pitch + CHAIN_NODE_WIDTH);
    expect(path?.line.startsWith(`M${2 * pitch + CHAIN_NODE_WIDTH / 2} 0`)).toBe(true);
    expect(path?.head).toContain(`L${CHAIN_NODE_WIDTH / 2} 4`);
  });
});

describe('recordedFor', () => {
  const graph = [node('a'), { type: 'waitFor', event: 'go' }, node('b'), node('b')];

  test('finds the one record of a name that is used once', () => {
    expect(recordedFor(graph, 0, [step('a'), step('b')])).toEqual({
      kind: 'found',
      step: step('a'),
    });
  });

  test('a name used twice in the definition, or twice in the record, is not guessed', () => {
    expect(recordedFor(graph, 2, [step('b')])).toEqual({ kind: 'ambiguous' });
    expect(recordedFor(graph, 0, [step('a'), step('a')])).toEqual({ kind: 'ambiguous' });
  });

  test('a step that has not been recorded is missing, and a node that is not one step has nothing', () => {
    expect(recordedFor(graph, 0, [])).toEqual({ kind: 'missing' });
    expect(recordedFor(graph, 1, [step('a')])).toBeNull();
    expect(
      recordedFor([{ type: 'parallel', steps: [{ name: 'x' }, { name: 'y' }] }], 0, [])
    ).toBeNull();
  });

  test('a name inside a branch counts against a step of the same name', () => {
    const branched = [
      node('a'),
      { type: 'branch', paths: [{ name: 'p', steps: [{ name: 'a' }] }] },
    ];
    expect(recordedFor(branched, 0, [step('a')])).toEqual({ kind: 'ambiguous' });
  });
});
