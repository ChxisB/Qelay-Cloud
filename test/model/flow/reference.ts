import type { Mode, NodeSpec } from './spec';
import { materialize } from './spec';

/**
 * The rules the model applied, counted over every run of the process. A history generator that never
 * reaches one of them would let the store be wrong there unseen, so the test insists each was reached.
 */
export const RULES = [
  'complete releases the parent',
  'fail policy fails the parent',
  'failed parent fails its own parent',
  'fail wins over the other policies of a group',
  'continue releases the parent at once',
  'ignore records the failure',
  'remove drops the edge only',
  'no policy keeps the parent waiting',
  'late failure is recorded',
  'late fail policy does nothing',
  'cancel releases the parent',
  'cancel of a parent leaves its children',
  'remove refused while a parent holds an edge',
  'remove of a finished job',
] as const;
export type Rule = (typeof RULES)[number];
export const COVERAGE = new Map<Rule, number>();
const hit = (rule: Rule): void => void COVERAGE.set(rule, (COVERAGE.get(rule) ?? 0) + 1);

/**
 * Where a job is, as the model sees it. `ready` is `waiting` or `prioritized` in the store: nothing in a
 * flow has a delay, and the model does not care about the order jobs are claimed in.
 */
export type Phase = 'waiting-children' | 'ready' | 'active' | 'completed' | 'failed' | 'gone';

export interface ModelNode {
  readonly id: string;
  readonly queue: string;
  readonly parent: string | null;
  /** The policy of the edge from `parent`. */
  readonly mode: Mode | null;
  readonly children: readonly string[];
  phase: Phase;
  /** The children this job, as a parent, still has an edge to. */
  readonly edges: Set<string>;
  /** The failures this job, as a parent, can read: `continue` and `ignore` children, by child. */
  readonly recorded: Map<string, { readonly mode: 'continue' | 'ignore'; readonly error: string }>;
  /** How many times a claim took this job. At most once, in a flow. */
  claims: number;
  leaseUntil: number;
}

/** A job that ended, as the parent's reaction needs to know it. */
export interface Change {
  readonly id: string;
  readonly outcome: 'completed' | 'failed';
  readonly error: string;
}

export interface FlowRecord {
  readonly no: number;
  readonly root: string;
  readonly ids: readonly string[];
  readonly spec: NodeSpec;
}

/**
 * The rules of a flow, written from the specification and not from the store: what each operation does
 * to the jobs, the edges between them and the failures a parent keeps. The store is checked against it
 * after every command.
 *
 * - A parent waits (`waiting-children`) until every child it still has an edge to has completed, then
 *   becomes ready, once.
 * - A failed child acts by its policy. `fail`: the parent fails, with its edges and failures gone, and
 *   its own parent reacts to that as to any failed child. `continue`: the failure is recorded, the edge
 *   dropped and the parent released at once, its other edges kept. `ignore`: recorded, edge dropped.
 *   `remove`: edge dropped, nothing recorded. No policy: the parent keeps waiting for a child that will
 *   not complete. Where several children of one parent end together, `fail` wins over `continue`, then
 *   `ignore`, then `remove`.
 * - A parent that was released already is not failed or released again, but a later failure of a child
 *   it has an edge to is recorded and its edge dropped by that child's policy.
 * - Cancelling a ready job or a parent: the job and its own edges and failures go; a cancelled child's
 *   edge goes from its parent, which is released if nothing else is awaited. The children of a cancelled
 *   parent go on as plain jobs.
 */
export class FlowModel {
  readonly nodes = new Map<string, ModelNode>();
  readonly flows: FlowRecord[] = [];
  /** Flows added so far: the number of the next one is this plus one. */
  added = 0;

  add(spec: NodeSpec): FlowRecord {
    const no = ++this.added;
    const { ids } = materialize(spec, no);
    let at = 0;
    const visit = (node: NodeSpec, parent: string | null): string => {
      const id = ids[at++]!;
      const children = node.children.map((child) => visit(child, id));
      this.nodes.set(id, {
        id,
        queue: node.queue,
        parent,
        mode: node.mode,
        children,
        phase: children.length > 0 ? 'waiting-children' : 'ready',
        edges: new Set(children),
        recorded: new Map(),
        claims: 0,
        leaseUntil: 0,
      });
      return id;
    };
    const root = visit(spec, null);
    const record = { no, root, ids, spec };
    this.flows.push(record);
    return record;
  }

  node(id: string): ModelNode {
    const found = this.nodes.get(id);
    if (!found) throw new Error(`the model has no job ${id}`);
    return found;
  }

  inPhase(phase: Phase, queue?: string): ModelNode[] {
    return [...this.nodes.values()]
      .filter((node) => node.phase === phase && (queue === undefined || node.queue === queue))
      .sort((a, b) => (a.id < b.id ? -1 : 1));
  }

  claim(id: string, leaseUntil: number): void {
    const node = this.node(id);
    node.phase = 'active';
    node.claims += 1;
    node.leaseUntil = leaseUntil;
  }

  /** Active jobs whose lease ended by `now`, as the recovery takes them: oldest lease first. */
  expired(now: number): ModelNode[] {
    return this.inPhase('active')
      .filter((node) => node.leaseUntil <= now)
      .sort((a, b) => a.leaseUntil - b.leaseUntil || (a.id < b.id ? -1 : 1));
  }

  /** Every edge of `parent` leads to a completed child (so a parent with no edge is resolved). */
  private resolved(parent: ModelNode): boolean {
    return [...parent.edges].every((child) => this.node(child).phase === 'completed');
  }

  private release(parent: ModelNode, released: string[]): void {
    parent.phase = 'ready';
    released.push(parent.id);
  }

  /**
   * Jobs ended together: completed, failed for good, or recovered after a lease ran out. Returns the
   * parents that became ready, in the order they did.
   */
  finish(changes: readonly Change[]): string[] {
    const released: string[] = [];
    for (const change of changes) this.node(change.id).phase = change.outcome;
    let pending = changes.filter((change) => this.node(change.id).parent !== null);
    while (pending.length > 0) {
      const byParent = new Map<string, Change[]>();
      for (const change of pending) {
        const parent = this.node(change.id).parent!;
        byParent.set(parent, [...(byParent.get(parent) ?? []), change]);
      }
      const next: Change[] = [];
      for (const [id, group] of [...byParent].sort(([a], [b]) => (a < b ? -1 : 1))) {
        const parent = this.node(id);
        const failures = group.filter((change) => change.outcome === 'failed');
        const waiting = parent.phase === 'waiting-children';
        // A parent that is not waiting and has no failed child to settle is not looked at.
        if (parent.phase === 'gone' || (!waiting && failures.length === 0)) continue;
        const withMode = (mode: Mode) =>
          failures.filter(
            (change) => parent.edges.has(change.id) && this.node(change.id).mode === mode
          );
        const [failing] = waiting ? withMode('fail') : [];
        if (!waiting && withMode('fail').length > 0) hit('late fail policy does nothing');
        if (failing) {
          hit('fail policy fails the parent');
          if (failures.length > 1) hit('fail wins over the other policies of a group');
          if (parent.parent !== null) hit('failed parent fails its own parent');
          parent.phase = 'failed';
          parent.edges.clear();
          parent.recorded.clear();
          const error = `Child job ${failing.id} failed: ${failing.error}`;
          next.push({ id: parent.id, outcome: 'failed', error });
          continue;
        }
        const continued = withMode('continue');
        const ignored = withMode('ignore');
        if (continued.length > 0) hit('continue releases the parent at once');
        if (ignored.length > 0) hit('ignore records the failure');
        if (!waiting && continued.length + ignored.length > 0) hit('late failure is recorded');
        if (withMode('remove').length > 0) hit('remove drops the edge only');
        if (
          waiting &&
          failures.some((c) => parent.edges.has(c.id) && this.node(c.id).mode === null)
        ) {
          hit('no policy keeps the parent waiting');
        }
        for (const change of continued) {
          parent.recorded.set(change.id, { mode: 'continue', error: change.error });
        }
        for (const change of ignored) {
          parent.recorded.set(change.id, { mode: 'ignore', error: change.error });
        }
        for (const change of [...continued, ...ignored, ...withMode('remove')]) {
          parent.edges.delete(change.id);
        }
        if (waiting && (continued.length > 0 || this.resolved(parent))) {
          if (continued.length === 0) hit('complete releases the parent');
          this.release(parent, released);
        }
      }
      pending = next.filter((change) => this.node(change.id).parent !== null);
    }
    return released;
  }

  /** The operator cancels a job: only a ready job or a parent can be. Returns whether it was, and the parents released. */
  cancel(id: string): { readonly ok: boolean; readonly released: string[] } {
    const node = this.nodes.get(id);
    const released: string[] = [];
    if (!node || (node.phase !== 'ready' && node.phase !== 'waiting-children')) {
      return { ok: false, released };
    }
    node.phase = 'gone';
    if (node.edges.size > 0) hit('cancel of a parent leaves its children');
    node.edges.clear();
    node.recorded.clear();
    if (node.parent !== null) {
      const parent = this.node(node.parent);
      parent.edges.delete(id);
      if (parent.phase === 'waiting-children' && this.resolved(parent)) {
        hit('cancel releases the parent');
        this.release(parent, released);
      }
    }
    return { ok: true, released };
  }

  /**
   * The operator removes a job. An active job and one a live parent still has an edge to (the parent
   * is ready, waiting for children or active) are refused. Anything else goes with its own edges and
   * failures; the edges its parent holds to it stay as history, and nothing is released.
   */
  remove(id: string): 'removed' | 'not-found' | 'active' | 'protected' {
    const node = this.nodes.get(id);
    if (!node || node.phase === 'gone') return 'not-found';
    if (node.phase === 'active') return 'active';
    const live: readonly Phase[] = ['ready', 'waiting-children', 'active'];
    for (const other of this.nodes.values()) {
      if (other.edges.has(id) && live.includes(other.phase)) {
        hit('remove refused while a parent holds an edge');
        return 'protected';
      }
    }
    if (node.phase === 'completed' || node.phase === 'failed') hit('remove of a finished job');
    node.phase = 'gone';
    node.edges.clear();
    node.recorded.clear();
    return 'removed';
  }
}
