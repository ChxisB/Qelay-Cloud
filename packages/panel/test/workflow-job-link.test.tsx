import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { owningExecution } from '../src/features/workflows/domain/workflowJob';
import type { JobFull } from '../src/lib/bqTypes';
import { useCapabilitiesStore } from '../src/lib/capabilities/store';
import { DEMO_CAPABILITIES } from '../src/lib/capabilities/types';
import { JobWorkflowLink } from '../src/pages/control/job/JobWorkflowLink';
import { mountFlows, serveRole, unmountAll } from './flow.helpers';
import './domSetup';

beforeEach(() => serveRole('viewer'));
afterEach(unmountAll);

const stepJob = (data: unknown, name = 'wf:step'): JobFull => ({ id: 'j1', name, data }) as JobFull;
const show = (job: JobFull) => mountFlows(<JobWorkflowLink job={job} />, '/job');

describe('the Job Inspector link to a workflow execution', () => {
  test('a workflow step job links to its execution', () => {
    const { host } = show(stepJob({ executionId: 'wf 1/a', step: 'charge' }));
    const link = host.querySelector('a');
    expect(link?.textContent).toBe('wf 1/a');
    expect(link?.getAttribute('href')).toBe('/workflows?execution=wf+1%2Fa');
    expect(host.textContent).toContain('Runs a step of');
  });

  test('any other job draws nothing', () => {
    expect(show(stepJob({ executionId: 'wf-1' }, 'send-email')).host.textContent).toBe('');
    expect(show({ id: 'older-server' } as JobFull).host.textContent).toBe('');
  });

  test('draws nothing where the server runs no workflows', () => {
    useCapabilitiesStore.setState({
      status: 'ready',
      caps: {
        ...DEMO_CAPABILITIES,
        features: { ...DEMO_CAPABILITIES.features, workflows: false },
      },
      error: null,
      key: 'test',
    });
    expect(show(stepJob({ executionId: 'wf-1' })).host.textContent).toBe('');
  });
});

describe('owningExecution', () => {
  test('reads only a text id from a job named like a step job', () => {
    expect(owningExecution({ name: 'wf:step', data: { executionId: 'wf-1' } })).toBe('wf-1');
    for (const data of [
      null,
      'wf-1',
      [],
      {},
      { executionId: 7 },
      { executionId: '' },
      { executionId: 'x'.repeat(257) },
    ]) {
      expect(owningExecution({ name: 'wf:step', data })).toBeNull();
    }
    expect(owningExecution({ name: 'other', data: { executionId: 'wf-1' } })).toBeNull();
    expect(owningExecution({})).toBeNull();
  });
});
