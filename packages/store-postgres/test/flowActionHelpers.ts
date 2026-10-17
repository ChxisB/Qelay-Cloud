import type {
  FlowActionRequest,
  FlowActionResult,
  FlowView,
  FlowViewNode,
} from '@qelay-cloud/core';
import { createMsgpackCodec } from '../src/codec';
import type { TestStore } from './storeHelpers';

const codec = createMsgpackCodec();

/** The node of `id` in a view; fails the test when it is not listed. */
export function nodeOf(view: FlowView, id: string): FlowViewNode {
  const node = view.nodes.find((candidate) => candidate.id === id);
  if (!node) throw new Error(`job ${id} is not in the view of ${view.root}`);
  return node;
}

/** `{id, expectedVersion}` for each of `ids`, at the version the view shows. */
export const seen = (view: FlowView, ...ids: string[]) =>
  ids.map((id) => ({ id, expectedVersion: nodeOf(view, id).version! }));

/** The current view of a flow; fails the test when there is none. */
export async function viewOf(t: TestStore, root: string, limit?: number): Promise<FlowView> {
  const view = await t.store.flows.view(root, limit === undefined ? {} : { limit });
  if (!view) throw new Error(`no flow has root ${root}`);
  return view;
}

/** An action as the control API sends it, with every job at the version a fresh view shows. */
export async function request(
  t: TestStore,
  root: string,
  action: FlowActionRequest['action'],
  ids: readonly string[],
  parent?: string
): Promise<FlowActionRequest> {
  const view = await viewOf(t, root);
  return { action, jobs: seen(view, ...ids), ...(parent !== undefined && { parent }) };
}

/** Runs an action against the current picture of the flow. */
export async function act(
  t: TestStore,
  root: string,
  action: FlowActionRequest['action'],
  ids: readonly string[],
  parent?: string
): Promise<FlowActionResult> {
  return t.store.flows.act(root, await request(t, root, action, ids, parent));
}

/**
 * Writes a flow of `size` jobs straight into the table: a root and `size - 1` children one level
 * below it, all waiting. For the size cap, which a flow added through `add` (at most 1,000 jobs) cannot
 * reach.
 */
export async function seedFlow(t: TestStore, root: string, size: number): Promise<void> {
  const payload = codec.encode({ name: 'seed', data: null });
  await t.fresh.sql`
    INSERT INTO qcloud_jobs (namespace, id, queue, payload, state, run_at, created_at, parent_id,
                             flow_root, flow_depth)
    SELECT 'test', CASE WHEN n = 0 THEN ${root} ELSE ${root} || '-' || n END, 'seeded',
           ${payload}, CASE WHEN n = 0 THEN 'waiting-children' ELSE 'waiting' END, 0, 0,
           CASE WHEN n = 0 THEN NULL ELSE ${root} END, ${root}, CASE WHEN n = 0 THEN 0 ELSE 1 END
    FROM generate_series(0, ${size - 1}) AS n`;
}
