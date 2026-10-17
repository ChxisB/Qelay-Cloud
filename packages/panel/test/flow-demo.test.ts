import { describe, expect, test } from 'bun:test';
import { promoteAvailability, retryAvailability } from '../src/features/flows/domain/flowActions';
import { buildFlowTree, countByState, needsAttention } from '../src/features/flows/domain/flowTree';
import {
  parseFlowActionResult,
  parseFlowList,
  parseFlowView,
} from '../src/features/flows/domain/flowWire';
import { DEMO_FLOW, DEMO_FLOW_ROOT, demoFlowReply } from '../src/lib/demo/flows';
import { demoJobForId } from '../src/lib/demo/jobs';

const jobs = Object.values(DEMO_FLOW) as Array<Record<string, unknown>>;

describe('flow demo fixture', () => {
  test('is the one flow, rooted where the list says', () => {
    expect(jobs.length).toBeGreaterThan(0);
    for (const job of jobs) expect(job.flowRoot).toBe(DEMO_FLOW_ROOT);
    expect(DEMO_FLOW[DEMO_FLOW_ROOT]?.parentId).toBeNull();
  });

  test('parents and children name each other, as the Control API does', () => {
    for (const job of jobs) {
      const id = String(job.id);
      for (const child of job.childrenIds as string[]) {
        expect(DEMO_FLOW[child]?.parentId).toBe(id);
      }
      if (job.parentId !== null) {
        expect(DEMO_FLOW[String(job.parentId)]?.childrenIds).toContain(id);
      }
      // A job is in no `dependsOn` set: the Control API does not model that edge.
      expect(job.dependsOn).toEqual([]);
    }
  });

  test('is what a job read returns, flow fields included', () => {
    for (const job of jobs) expect(demoJobForId(String(job.id))).toBe(DEMO_FLOW[String(job.id)]!);
    expect(demoJobForId('flow-ship-2')).toMatchObject({
      parentId: DEMO_FLOW_ROOT,
      childrenIds: ['flow-label-4'],
      flowRoot: DEMO_FLOW_ROOT,
    });
  });
});

describe('flow demo replies satisfy the panel wire contract', () => {
  test('the list parses and names the stuck flow', () => {
    const reply = demoFlowReply(['flows'], 'GET');
    expect(reply.status).toBe(200);
    const list = parseFlowList(reply.body);
    expect(list.flows).toHaveLength(1);
    expect(list.flows[0]).toMatchObject({ id: DEMO_FLOW_ROOT, blocked: 1, total: jobs.length });
    const sum = Object.values(list.flows[0]!.states).reduce((a, b) => a + b, 0);
    expect(sum).toBe(list.flows[0]!.total);
  });

  test('the view parses, is whole, and has the failure that holds a parent', () => {
    const reply = demoFlowReply(['flows', DEMO_FLOW_ROOT], 'GET');
    expect(reply.status).toBe(200);
    const view = parseFlowView(reply.body);
    expect(view.root).toBe(DEMO_FLOW_ROOT);
    expect(view.truncated).toBe(false);
    expect(view.nodes).toHaveLength(jobs.length);
    const tree = buildFlowTree(view.nodes);
    expect(tree.tops.map((n) => n.id)).toEqual([DEMO_FLOW_ROOT]);
    const attention = view.nodes.filter(needsAttention);
    expect(attention.map((n) => n.id)).toEqual(['flow-notify-3']);
    expect(retryAvailability(tree, tree.byId.get('flow-notify-3')!)).toEqual({ ok: true });
    expect(promoteAvailability(tree, tree.byId.get('flow-ship-2')!)).toMatchObject({ ok: false });
    expect(countByState(view.nodes).reduce((a, [, n]) => a + n, 0)).toBe(jobs.length);
  });

  test('an action answers as the server would, naming the jobs it changed', () => {
    const reply = demoFlowReply(['flows', DEMO_FLOW_ROOT, 'actions'], 'POST', {
      action: 'retry-failed',
      jobs: [{ id: 'flow-notify-3', expectedVersion: 5 }],
    });
    expect(reply.status).toBe(200);
    expect(parseFlowActionResult(reply.body)).toEqual({
      action: 'retry-failed',
      changes: [{ id: 'flow-notify-3', queue: 'emails', from: 'failed', to: 'waiting' }],
    });
    const removal = demoFlowReply(['flows', DEMO_FLOW_ROOT, 'actions'], 'POST', {
      action: 'remove',
      jobs: [{ id: DEMO_FLOW_ROOT, expectedVersion: 4 }],
      confirm: DEMO_FLOW_ROOT,
    });
    expect(parseFlowActionResult(removal.body).changes[0]?.to).toBe('removed');
  });

  test('says no for an unknown flow, an unknown action and a wrong method', () => {
    expect(demoFlowReply(['flows', 'other'], 'GET')).toMatchObject({
      status: 404,
      body: { code: 'flow_not_found' },
    });
    expect(
      demoFlowReply(['flows', DEMO_FLOW_ROOT, 'actions'], 'POST', { action: 'explode' }).status
    ).toBe(400);
    expect(demoFlowReply(['flows', DEMO_FLOW_ROOT], 'DELETE').status).toBe(405);
  });
});
