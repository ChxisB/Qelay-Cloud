import { afterAll, beforeAll, beforeEach } from 'bun:test';
import type {
  Execution,
  StepRecord,
  WorkflowDefinitionInput,
  WorkflowStepJob,
} from '@qelay-cloud/core';
import { DEFAULT_WORKFLOW_QUEUE } from '@qelay-cloud/core';
import type { JobsApi, JobsFixture } from './jobsFixture';
import { openJobsFixture } from './jobsFixture';

/** A definition with a pivot, so a graph in a response has more than one kind of node. */
export const definition = (name: string, hash: string): WorkflowDefinitionInput => ({
  name,
  hash,
  revision: `rev-${hash}`,
  graph: [
    { type: 'step', step: { name: 'charge', retry: 3, timeout: 5_000, compensates: true } },
    { type: 'waitFor', event: 'approved', timeout: 60_000 },
    { type: 'pivot' },
  ],
});

export const completed = (at: number, extra: Partial<StepRecord> = {}): StepRecord => ({
  status: 'completed',
  startedAt: at,
  completedAt: at + 5,
  attempts: 1,
  ...extra,
});

/**
 * Saves a run as an engine would. A run that carries `signals` is saved running, receives them
 * through `recordSignal`, and is then moved to its state with the store's own write.
 */
export async function seedRun(
  f: JobsFixture,
  id: string,
  overrides: Partial<Execution> = {}
): Promise<Execution> {
  const now = f.t.clock.now();
  const { signals = {}, state = 'running', ...rest } = overrides;
  const events = Object.entries(signals);
  await f.store.workflows.save({
    id,
    workflowName: 'order',
    input: { orderId: id },
    steps: {},
    currentNodeIndex: 0,
    createdAt: now,
    updatedAt: now,
    ...rest,
    state: events.length === 0 ? state : 'running',
    signals: {},
  });
  for (const [event, payload] of events) await f.store.workflows.recordSignal(id, event, payload);
  if (events.length > 0 && state !== 'running') {
    const stored = (await f.store.workflows.get(id))!;
    stored.state = state;
    await f.store.workflows.update(stored);
  }
  return (await f.store.workflows.get(id))!;
}

/** Parks a seeded run at `waitFor(event)` the way the engine does. */
export async function park(f: JobsFixture, id: string, event: string, deadlineAt?: number) {
  const outcome = await f.store.workflows.parkForSignal(id, event, deadlineAt);
  if (outcome.parked !== true) throw new Error(`park: ${id} did not park`);
}

/** The step jobs on the engine queue, claimed off it (the queue is empty afterwards). */
export async function stepJobs(
  f: JobsFixture,
  queue: string = DEFAULT_WORKFLOW_QUEUE
): Promise<WorkflowStepJob[]> {
  const claimed = await f.store.claim(queue, 'w', 100);
  expectAllStepJobs(claimed.map((job) => job.name));
  return claimed.map((job) => job.data as WorkflowStepJob);
}

function expectAllStepJobs(names: string[]): void {
  for (const name of names) if (name !== 'wf:step') throw new Error(`unexpected job ${name}`);
}

/** Makes a run look as if its worker died: nothing wrote it for `ms`. */
export const idleFor = (f: JobsFixture, ms: number): void => {
  f.t.clock.advance(ms);
};

/** What the action tests share: the store and API over one migrated schema, emptied before each test. */
export function useWorkflowApi() {
  let opened: JobsFixture;
  let api: JobsApi;
  beforeAll(async () => {
    opened = await openJobsFixture();
  });
  afterAll(() => opened.drop());
  beforeEach(async () => {
    await opened.reset();
    api = opened.api({ summaryCacheMs: 0 });
  });
  /** Reads through to the fixture once it is open, so a test can name it while the suite is declared. */
  const fixture = new Proxy({} as JobsFixture, {
    get: (_target, key) => Reflect.get(opened, key),
  });
  const run = {
    fixture,
    get api() {
      return api;
    },
    version: async (id: string) => (await fixture.store.workflows.get(id))!.version!,
    stateOf: async (id: string) => (await fixture.store.workflows.get(id))!.state,
    act: (id: string, body: Record<string, unknown>) =>
      api.call('POST', `/workflows/executions/${id}/actions`, body),
    audited: async () => (await fixture.store.audit.list({ limit: 100 })).items,
    t0: () => fixture.t.clock.now(),
    /** A run parked at `waitFor('approved')`, as an engine leaves it. */
    async parked(id = 'w1') {
      await seedRun(fixture, id, { currentNodeIndex: 1, steps: { charge: completed(run.t0()) } });
      await park(fixture, id, 'approved');
    },
  };
  return run;
}
