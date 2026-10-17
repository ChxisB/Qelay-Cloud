import type { FlowTree } from './flowTree';
import type { FlowActionBody, FlowJobVersion, FlowNode, FlowView } from './flowWire';

/** An action the picture allows, or the reason it does not: the server still decides. */
export type Availability = { readonly ok: true } | { readonly ok: false; readonly reason: string };

const yes: Availability = { ok: true };
const no = (reason: string): Availability => ({ ok: false, reason });

const FINISHED = new Set(['completed', 'failed']);

const versionOf = (node: FlowNode): FlowJobVersion | null =>
  node.version === null ? null : { id: node.id, expectedVersion: node.version };

/**
 * A failed child can be retried when it holds a waiting parent back, unless it is a parent that never
 * ran: it failed because one of its own children failed, so running it again would run its processor
 * with no children done. Releasing it from above (`promote` on its own parent) is the way out.
 */
export function retryAvailability(tree: FlowTree, node: FlowNode): Availability {
  if (node.state !== 'failed') return no('Only a failed job can be retried.');
  if (!node.blocking)
    return no('It does not hold its parent back, so retrying would not release anything.');
  if (node.version === null) return no('Nothing of it is stored any more.');
  if (node.attempts === 0 && (tree.children.get(node.id)?.length ?? 0) > 0) {
    return no('It never ran: a child of its own failed. Release its parent, or remove the flow.');
  }
  return yes;
}

/** The failed children of `parent` that hold it back. */
export const holdersOf = (tree: FlowTree, parent: FlowNode): FlowNode[] =>
  (tree.children.get(parent.id) ?? []).filter((child) => child.blocking && child.version !== null);

/** A parent can be released when failed children are all that keep it waiting. */
export function promoteAvailability(tree: FlowTree, parent: FlowNode): Availability {
  if (parent.state !== 'waiting-children') return no('It is not waiting for its children.');
  if (parent.version === null) return no('Nothing of it is stored any more.');
  const kids = tree.children.get(parent.id) ?? [];
  if (!kids.some((child) => child.blocking)) return no('No failed child holds it back.');
  const unfinished = kids.filter((child) => !child.removed && !FINISHED.has(child.state));
  if (unfinished.length > 0) {
    return no(
      `${unfinished.length} ${unfinished.length === 1 ? 'child has' : 'children have'} not finished: it is waiting, not stuck.`
    );
  }
  return yes;
}

/** Every job of the flow, so only a flow shown whole can be removed; a running job blocks it. */
export function removeAvailability(view: FlowView): Availability {
  if (view.truncated) {
    return no(
      `Only ${view.nodes.length} of ${view.total} jobs are shown. Show the whole flow to remove it.`
    );
  }
  const running = view.nodes.filter((node) => node.state === 'active').length;
  if (running > 0) {
    return no(
      `${running} ${running === 1 ? 'job is' : 'jobs are'} running. Wait for ${running === 1 ? 'it' : 'them'} to finish.`
    );
  }
  return yes;
}

/** The jobs that are stuck: failed and holding a parent, and a retry would be accepted. */
export const retryableNodes = (tree: FlowTree): FlowNode[] =>
  [...tree.byId.values()].filter((node) => retryAvailability(tree, node).ok);

function versions(nodes: readonly FlowNode[]): FlowJobVersion[] {
  const out: FlowJobVersion[] = [];
  for (const node of nodes) {
    const version = versionOf(node);
    if (version) out.push(version);
  }
  return out;
}

/** `retry-failed` for these jobs: each at the version shown. */
export const retryBody = (nodes: readonly FlowNode[]): FlowActionBody => ({
  action: 'retry-failed',
  jobs: versions(nodes),
});

/** `promote` of `parent`: it and every failed child that holds it, each at the version shown. */
export const promoteBody = (tree: FlowTree, parent: FlowNode): FlowActionBody => ({
  action: 'promote',
  jobs: versions([parent, ...holdersOf(tree, parent)]),
  parent: parent.id,
});

/** `remove` of the whole flow: every stored job at its version, and the root id as the confirmation. */
export const removeBody = (view: FlowView): FlowActionBody => ({
  action: 'remove',
  jobs: versions(view.nodes),
  confirm: view.root,
});
