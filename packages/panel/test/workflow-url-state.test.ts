import { describe, expect, test } from 'bun:test';
import {
  patchWorkflowSearchParams,
  readWorkflowUrlState,
  workflowHref,
  workflowSearchParams,
} from '../src/features/workflows/domain/workflowUrlState';

const read = (query: string) => readWorkflowUrlState(new URLSearchParams(query));

describe('the address of the workflows page', () => {
  test('an empty address is the list of everything', () => {
    expect(read('')).toEqual({
      workflowName: '',
      state: '',
      offset: 0,
      executionId: null,
      tab: 'summary',
    });
  });

  test('a state, workflow, page and execution round-trip through the address', () => {
    const state = read('workflow=order&state=waiting&offset=50&execution=wf-1&tab=steps');
    expect(state).toEqual({
      workflowName: 'order',
      state: 'waiting',
      offset: 50,
      executionId: 'wf-1',
      tab: 'steps',
    });
    expect(workflowSearchParams(state).toString()).toBe(
      'workflow=order&state=waiting&offset=50&execution=wf-1&tab=steps'
    );
  });

  test('a value the page does not know is dropped, not carried', () => {
    expect(read('state=exploded&tab=steps').state).toBe('');
    expect(read('execution=wf-1&tab=nonsense').tab).toBe('summary');
    expect(read('tab=steps').tab).toBe('summary');
    expect(read(`workflow=${'x'.repeat(257)}`).workflowName).toBe('');
    // An id is sent as one encoded path segment, so a slash is fine; a segment the URL parser would resolve is not.
    expect(read('execution=a%2Fb').executionId).toBe('a/b');
    expect(read('execution=..').executionId).toBeNull();
    expect(read('execution=.').executionId).toBeNull();
    expect(read(`execution=${'x'.repeat(1025)}`).executionId).toBeNull();
  });

  test('an offset is a whole page start within the range the server lists', () => {
    expect(read('offset=60').offset).toBe(50);
    for (const bad of ['-1', '1.5', 'abc', '007', '99999999999999999999', '1000026']) {
      expect(read(`offset=${bad}`).offset).toBe(0);
    }
  });

  test('defaults are left out, so one view has one address', () => {
    expect(workflowSearchParams(read('execution=wf-1&tab=summary')).toString()).toBe(
      'execution=wf-1'
    );
    expect(workflowSearchParams(read('offset=0')).toString()).toBe('');
  });

  test('closing an execution drops its tab; a patch keeps the rest', () => {
    const params = new URLSearchParams('state=failed&execution=wf-1&tab=graph');
    expect(patchWorkflowSearchParams(params, { executionId: null }).toString()).toBe(
      'state=failed'
    );
    expect(patchWorkflowSearchParams(params, { tab: 'payloads' }).toString()).toBe(
      'state=failed&execution=wf-1&tab=payloads'
    );
  });

  test('the link to an execution encodes its id', () => {
    expect(workflowHref('wf 1&x=2')).toBe('/workflows?execution=wf+1%26x%3D2');
  });
});
