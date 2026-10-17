import { inspect } from 'node:util';
import type { Execution, WorkflowStorePort } from '@qelay-cloud/core';
import type { WorkflowWorld } from './world';

/** What an operation did: the value it returned, or the error it threw, in a form two stores can be compared by. */
export type Outcome =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: string };

export type Act = (store: WorkflowStorePort, world: WorkflowWorld) => Promise<unknown>;

const show = (value: unknown): string => inspect(value, { depth: 8, breakLength: Infinity });

export async function capture(work: () => Promise<unknown>): Promise<Outcome> {
  try {
    return { ok: true, value: await work() };
  } catch (error) {
    const named = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    return { ok: false, error: named };
  }
}

/** The Postgres store and the reference told to do the same thing: they must answer the same. */
export async function both(world: WorkflowWorld, label: string, act: Act): Promise<Outcome> {
  const real = await capture(() => act(world.real, world));
  const reference = await capture(() => act(world.reference, world));
  if (!Bun.deepEquals(real, reference, true)) {
    world.violate(
      'WF2.outcome',
      `${label}\n  store:     ${show(real)}\n  reference: ${show(reference)}`
    );
  }
  return real;
}

const LIST = { limit: 1000 } as const;

/** Every run of the store, newest first. The history never makes more than a handful. */
const everyRun = (store: WorkflowStorePort): Promise<Execution[]> =>
  store.list(undefined, undefined, LIST);

const sameSignals = (before: Record<string, unknown>, now: Record<string, unknown>): boolean =>
  Object.keys(before).every(
    (key) => Object.hasOwn(now, key) && Bun.deepEquals(before[key], now[key], true)
  );

/**
 * After every command: what the store holds is checked against what was last seen of it (a signal
 * never lost, a version never lower, the archive never smaller), then against the reference.
 */
export async function verifyWorkflows(world: WorkflowWorld): Promise<void> {
  const runs = await everyRun(world.real);
  const present = new Set(runs.map((run) => run.id));
  for (const id of [...world.seen.keys()]) if (!present.has(id)) world.seen.delete(id);
  for (const run of runs) {
    const before = world.seen.get(run.id);
    if (before && !sameSignals(before.signals, run.signals)) {
      world.violate(
        'WF3.signals',
        `${run.id} had signals ${show(before.signals)}, now ${show(run.signals)}`
      );
    }
    if (before && (run.version ?? 0) < before.version) {
      world.violate(
        'WF4.version',
        `${run.id} was at version ${before.version}, now ${run.version}`
      );
    }
    world.seen.set(run.id, { version: run.version ?? 0, signals: structuredClone(run.signals) });
  }
  const archived = [await world.real.getArchivedCount(), await world.reference.getArchivedCount()];
  if (archived[0]! < world.archived) {
    world.violate('WF5.archive', `the archive held ${world.archived} runs, now ${archived[0]}`);
  }
  world.archived = archived[0]!;

  const expected = await everyRun(world.reference);
  const same = Bun.deepEquals(runs, expected, true);
  if (!same || archived[0] !== archived[1]) {
    world.violate(
      'WF1.state',
      `store:     ${show(runs)} (${archived[0]} archived)\n  reference: ${show(expected)} (${archived[1]} archived)`
    );
  }
}
