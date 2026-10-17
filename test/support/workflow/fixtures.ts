import { afterAll, beforeAll, beforeEach } from 'bun:test';
import type { Clock, Execution, WorkflowStorePort } from '../../../packages/core/src';
import type { ManualClock } from '../clock';

/** The start of every contract test's clock. */
export const T0 = 1_800_000_000_000;

/** A workflow store under test: the store itself, the manual clock it reads, and how to start over. */
export interface WorkflowHarness {
  readonly store: WorkflowStorePort;
  readonly clock: ManualClock;
  /** Empties the store and puts the clock back at `T0`. */
  reset(): Promise<void>;
  close(): Promise<void>;
}

export type OpenWorkflowStore = () => Promise<WorkflowHarness>;

/** Opens the store once for the tests registered after it, and empties it before each of them. */
export function useHarness(open: OpenWorkflowStore): WorkflowHarness {
  let opened: WorkflowHarness;
  beforeAll(async () => {
    opened = await open();
  });
  afterAll(async () => {
    await opened.close();
  });
  beforeEach(async () => {
    await opened.reset();
  });
  return {
    get store() {
      return opened.store;
    },
    get clock() {
      return opened.clock;
    },
    reset: () => opened.reset(),
    close: () => opened.close(),
  };
}

/** A new running execution, created now. */
export function execution(clock: Clock, id: string, overrides: Partial<Execution> = {}): Execution {
  const now = clock.now();
  return {
    id,
    workflowName: 'order',
    state: 'running',
    input: { n: 1 },
    steps: {},
    currentNodeIndex: 0,
    signals: {},
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/** Saves a new execution and reads it back, as an engine would. */
export async function seed(
  h: Pick<WorkflowHarness, 'store' | 'clock'>,
  id: string,
  overrides: Partial<Execution> = {}
): Promise<Execution> {
  await h.store.save(execution(h.clock, id, overrides));
  const stored = await h.store.get(id);
  if (!stored) throw new Error(`seed: ${id} was not stored`);
  return stored;
}

/** Moves a stored execution to `state` through the store's own write, returning the copy read back. */
export async function moveTo(
  h: Pick<WorkflowHarness, 'store'>,
  id: string,
  changes: Partial<Execution>
): Promise<Execution> {
  const current = (await h.store.get(id))!;
  Object.assign(current, changes);
  await h.store.update(current);
  return (await h.store.get(id))!;
}

/** The ids of a listing, in order. */
export const ids = (list: readonly Execution[]): string[] => list.map((e) => e.id);
