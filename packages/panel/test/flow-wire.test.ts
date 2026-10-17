import { describe, expect, test } from 'bun:test';
import {
  describeActionError,
  describeActionResult,
} from '../src/features/flows/application/flowMessages';
import {
  flowHref,
  flowIdError,
  flowSearchParams,
  patchFlowSearchParams,
  readFlowUrlState,
} from '../src/features/flows/domain/flowUrlState';
import {
  FlowPayloadError,
  parseFlowActionResult,
  parseFlowList,
  parseFlowView,
} from '../src/features/flows/domain/flowWire';
import { BqError } from '../src/lib/bq';
import { flowList } from './flow.helpers';

describe('flow wire', () => {
  const nodeWire = {
    id: 'a',
    queue: 'q',
    state: 'failed',
    version: 3,
    parentId: null,
    depth: 0,
    attempts: 1,
    createdAt: 1,
    completedAt: null,
    error: 'boom',
    mode: null,
    blocking: true,
    removed: false,
  };

  test('reads a flow view from the envelope the server wraps it in', () => {
    const view = parseFlowView({
      ok: true,
      flow: { root: 'a', nodes: [nodeWire], total: 1, truncated: false, limit: 1000, failures: [] },
    });
    expect(view.nodes[0]).toMatchObject({ id: 'a', blocking: true, version: 3 });
  });

  test('refuses what is not a flow, naming what was expected', () => {
    for (const bad of [
      null,
      {},
      { flow: { root: 'a' } },
      {
        flow: {
          root: 'a',
          nodes: [{ ...nodeWire, mode: 'later' }],
          total: 1,
          truncated: false,
          limit: 1,
          failures: [],
        },
      },
      {
        flow: {
          root: 'a',
          nodes: [{ ...nodeWire, version: -1 }],
          total: 1,
          truncated: false,
          limit: 1,
          failures: [],
        },
      },
    ]) {
      expect(() => parseFlowView(bad)).toThrow(FlowPayloadError);
    }
    expect(() => parseFlowList({ flows: 'no' })).toThrow('list of flows');
    expect(() => parseFlowActionResult({ action: 'undo', changes: [] })).toThrow(
      'result for the action'
    );
  });

  test('reads a list of flows and an action result', () => {
    const list = flowList();
    expect(parseFlowList(list)).toEqual(list);
    const result = {
      action: 'remove',
      changes: [{ id: 'a', queue: 'q', from: 'failed', to: 'removed' }],
    };
    expect(parseFlowActionResult({ ok: true, ...result })).toEqual(result);
  });
});

describe('flow address', () => {
  test('reads the root and the selected job, and a job needs a root', () => {
    expect(readFlowUrlState(new URLSearchParams('root=r&node=n'))).toEqual({
      root: 'r',
      node: 'n',
    });
    expect(readFlowUrlState(new URLSearchParams('node=n'))).toEqual({ root: '', node: null });
    expect(readFlowUrlState(new URLSearchParams('root=..&node=n'))).toEqual({
      root: '',
      node: null,
    });
    expect(
      readFlowUrlState(new URLSearchParams(`root=r&node=${'x'.repeat(2000)}`)).node
    ).toBeNull();
  });

  test('names what is wrong with an id that cannot be in a path', () => {
    expect(flowIdError('ok')).toBeNull();
    expect(flowIdError('  ')).toContain('must not be empty');
    expect(flowIdError('.')).toContain('path traversal');
    expect(flowIdError('x'.repeat(1025))).toContain('1024');
  });

  test('writes only what is set, in a fixed order, and patches keep the rest', () => {
    expect(flowSearchParams({ root: '', node: 'n' }).toString()).toBe('');
    expect(flowSearchParams({ root: 'r', node: null }).toString()).toBe('root=r');
    expect(flowSearchParams({ root: 'r', node: 'n' }).toString()).toBe('root=r&node=n');
    expect(
      patchFlowSearchParams(new URLSearchParams('root=r&node=n&junk=1'), { node: null }).toString()
    ).toBe('root=r');
    expect(
      patchFlowSearchParams(new URLSearchParams('root=r&node=n'), { root: 's' }).toString()
    ).toBe('root=s&node=n');
  });

  test('links to a flow, with a job selected unless it is the root', () => {
    expect(flowHref('r')).toBe('/flows?root=r');
    expect(flowHref('r', 'r')).toBe('/flows?root=r');
    expect(flowHref('r', 'a b')).toBe('/flows?root=r&node=a+b');
    expect(flowHref('')).toBe('/flows');
  });
});

describe('flow messages', () => {
  test('says what each action did, in the singular and the plural', () => {
    const change = { id: 'a', queue: 'q', from: 'failed', to: 'waiting' };
    expect(describeActionResult({ action: 'retry-failed', changes: [change] })).toContain(
      '1 job was put back on its queue'
    );
    expect(describeActionResult({ action: 'retry-failed', changes: [change, change] })).toContain(
      '2 jobs were put back'
    );
    expect(describeActionResult({ action: 'promote', changes: [] })).toContain(
      'The parent was released'
    );
    expect(describeActionResult({ action: 'remove', changes: [change, change, change] })).toBe(
      'The flow was removed: 3 jobs deleted.'
    );
  });

  test('a refusal that means the picture is stale says so and asks for a reload', () => {
    for (const code of [
      'version_conflict',
      'flow_changed',
      'flow_active',
      'flow_not_retryable',
      'flow_not_found',
    ]) {
      const notice = describeActionError(new BqError('server words', 409, code));
      expect(notice).toMatchObject({ kind: 'error', reload: true });
      expect(notice.text).toEndWith('The flow was reloaded.');
    }
  });

  test('a flow that is not stuck gives the reason the server found', () => {
    const notice = describeActionError(
      new BqError('x', 409, 'flow_not_stuck', { reason: 'children_unfinished' })
    );
    expect(notice.text).toContain('have not finished');
    expect(notice.reload).toBe(true);
  });

  test('an error with no known code shows the server words and does not reload', () => {
    expect(describeActionError(new BqError('Nope', 500, 'internal'))).toEqual({
      kind: 'error',
      text: 'Nope',
      reload: false,
    });
    expect(describeActionError(new Error('offline'))).toEqual({
      kind: 'error',
      text: 'offline',
      reload: false,
    });
    expect(describeActionError('weird').text).toBe('The action failed.');
    expect(describeActionError(new BqError('x', 400, 'confirmation_required')).reload).toBe(false);
  });
});
