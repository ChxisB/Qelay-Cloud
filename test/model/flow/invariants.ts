import { flowDefectsIn } from '../../../packages/store-postgres/test/flowHelpers';
import type { ModelNode, Phase } from './reference';
import type { FlowWorld } from './world';

interface JobRow {
  readonly id: string;
  readonly queue: string;
  readonly state: string;
  readonly parent_id: string | null;
  readonly rung_at: string | null;
}

/** What the store calls each state the model tells apart. Nothing in a flow is delayed. */
const PHASE_OF: Readonly<Record<string, Phase>> = {
  waiting: 'ready',
  prioritized: 'ready',
  'waiting-children': 'waiting-children',
  active: 'active',
  completed: 'completed',
  failed: 'failed',
};

const keyOf = (node: ModelNode): string => `${node.queue}:${node.id}`;

/** The two sets compared as sorted lists: what only the store has, and what only the model has. */
function difference(store: Iterable<string>, model: Iterable<string>): string {
  const inStore = new Set(store);
  const inModel = new Set(model);
  const extra = [...inStore].filter((item) => !inModel.has(item)).sort();
  const missing = [...inModel].filter((item) => !inStore.has(item)).sort();
  return `the store also has [${extra.join(', ')}], the model also has [${missing.join(', ')}]`;
}

const sameSet = (a: Iterable<string>, b: Iterable<string>): boolean => {
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && [...left].every((item) => right.has(item));
};

export async function readJobs(world: FlowWorld): Promise<Map<string, JobRow>> {
  const rows = await world.sql<JobRow[]>`
    SELECT id, queue, state, parent_id, rung_at FROM qcloud_jobs WHERE namespace = ${world.namespace}`;
  return new Map(rows.map((row) => [row.id, row]));
}

/** Runs after every command: the whole store against the model. */
export async function verifyFlows(world: FlowWorld): Promise<void> {
  const { model, sql, namespace, store } = world;
  const jobs = await readJobs(world);

  // F1: the jobs.
  for (const node of model.nodes.values()) {
    const row = jobs.get(node.id);
    const actual = row === undefined ? 'gone' : (PHASE_OF[row.state] ?? row.state);
    if (actual !== node.phase) {
      world.violate(
        'F1.state',
        `${node.id} is ${actual} in the store but ${node.phase} in the model`
      );
    }
    if (row && (row.queue !== node.queue || row.parent_id !== node.parent)) {
      world.violate(
        'F1.state',
        `${node.id} is in ${row.queue} under ${row.parent_id}, not ${node.queue} under ${node.parent}`
      );
    }
  }
  for (const id of jobs.keys()) {
    if (!model.nodes.has(id))
      world.violate('F1.state', `the store holds ${id}, which no flow made`);
  }

  // F2: the edges, with their policies.
  const edgeRows = await sql<
    Array<{ job_id: string; dependency_id: string; on_failure: string | null }>
  >`
    SELECT job_id, dependency_id, on_failure FROM qcloud_dependencies WHERE namespace = ${namespace}`;
  const edges = edgeRows.map(
    (row) => `${row.job_id}>${row.dependency_id}[${row.on_failure ?? ''}]`
  );
  const modelEdges = [...model.nodes.values()].flatMap((parent) =>
    [...parent.edges].map((child) => `${parent.id}>${child}[${model.node(child).mode ?? ''}]`)
  );
  if (!sameSet(edges, modelEdges)) world.violate('F2.edges', difference(edges, modelEdges));

  // F3: the failures a parent keeps.
  const failureRows = await sql<
    Array<{ parent_id: string; child_id: string; mode: string; error: string }>
  >`
    SELECT parent_id, child_id, mode, error FROM qcloud_flow_failures WHERE namespace = ${namespace}`;
  const failures = failureRows.map(
    (row) => `${row.parent_id}>${row.child_id}[${row.mode}] ${row.error}`
  );
  const modelFailures = [...model.nodes.values()].flatMap((parent) =>
    [...parent.recorded].map(
      ([child, { mode, error }]) => `${parent.id}>${child}[${mode}] ${error}`
    )
  );
  if (!sameSet(failures, modelFailures))
    world.violate('F3.failures', difference(failures, modelFailures));

  // What a parent's processor and the inspector read agree with the tables.
  for (const parent of model.nodes.values()) {
    if (parent.phase === 'gone' || (parent.edges.size === 0 && parent.recorded.size === 0))
      continue;
    const children = [...parent.edges].map((id) => model.node(id));
    // The completion record of a child that was removed is the sweep's to keep or drop: not read.
    if (!children.some((child) => child.phase === 'gone')) {
      const done = children.filter((child) => child.phase === 'completed').map(keyOf);
      const waiting = children.filter((child) => child.phase !== 'completed').map(keyOf);
      const deps = await store.flows.dependencies(parent.id);
      const values = await store.flows.childrenValues(parent.id);
      const reads: Array<[string, Iterable<string>, string[]]> = [
        ['processed', Object.keys(deps.processed), done],
        ['unprocessed', deps.unprocessed, waiting],
        ['children values of', Object.keys(values), done],
      ];
      for (const [what, read, expected] of reads) {
        if (!sameSet(read, expected)) {
          world.violate(
            'F3.failures',
            `${parent.id} reads ${what} [${[...read]}], expected [${expected}]`
          );
        }
      }
    }
    for (const mode of ['continue', 'ignore'] as const) {
      const read = await (
        mode === 'continue' ? store.flows.failedChildren : store.flows.ignoredFailures
      )(parent.id);
      const expected = [...parent.recorded]
        .filter(([, entry]) => entry.mode === mode)
        .map(([child]) => keyOf(model.node(child)));
      if (!sameSet(Object.keys(read), expected)) {
        world.violate(
          'F3.failures',
          `${parent.id} reads ${mode} failures of [${Object.keys(read)}], expected [${expected}]`
        );
      }
    }
  }

  // F6: nothing dangling, orphaned or stuck.
  const defects = await flowDefectsIn(sql, namespace);
  if (defects.length > 0) world.violate('F6.noDefects', defects.join('; '));
}

/** Every ready job has been rung since it became ready: what the tick is there to make sure of. */
export async function verifyAllRung(world: FlowWorld): Promise<void> {
  const jobs = await readJobs(world);
  for (const node of world.model.inPhase('ready')) {
    if (jobs.get(node.id)?.rung_at == null) {
      world.violate('F9.tick', `${node.id} is claimable and was not rung after the tick`);
    }
  }
}
