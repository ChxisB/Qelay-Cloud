import type { Execution, ExecutionState, WorkflowStorePort } from '@qelay-cloud/core';
import fc from 'fast-check';
import { errorHas, EVENTS, IDS, NAMES, Op, STATES, valueOf } from './op';
import { QUERIES } from './queries';

interface Change {
  readonly state: ExecutionState;
  readonly node: number;
  readonly failure: string | undefined;
  readonly step: string;
}

function applyChange(exec: Execution, change: Change): void {
  exec.state = change.state;
  exec.currentNodeIndex = change.node;
  exec.steps = {
    ...exec.steps,
    [change.step]: { status: 'completed', result: change.node } as never,
  };
  if (change.failure === undefined) delete exec.failureReason;
  else exec.failureReason = change.failure;
}

/** An engine that read the run, did some work and writes it back; `stale` lets a second engine write first. */
function update(id: string, change: Change, stale: boolean): Op {
  const label = `update(${id}, ${change.state}@${change.node}, ${change.step}${stale ? ', after another engine' : ''})`;
  return new Op(
    label,
    async (store) => {
      const mine = await store.get(id);
      if (!mine) return 'missing';
      if (stale) {
        const other = (await store.get(id))!;
        other.currentNodeIndex += 1;
        await store.update(other);
      }
      applyChange(mine, change);
      await store.update(mine);
      return { version: mine.version, updatedAt: mine.updatedAt, stored: await store.get(id) };
    },
    (outcome) =>
      errorHas(outcome, 'ExecutionStaleError')
        ? 'update.stale'
        : outcome.ok && outcome.value === 'missing'
          ? 'update.missing'
          : 'update.ok'
  );
}

const save = (id: string, name: string, parent: string | undefined): Op =>
  new Op(
    `save(${id}, ${name}${parent ? `, child of ${parent}` : ''})`,
    async (store, world) => {
      await store.save(
        world.fresh(id, { workflowName: name, ...(parent ? { parentExecutionId: parent } : {}) })
      );
      return (await store.get(id))?.version;
    },
    (outcome) => (outcome.ok ? 'save.created' : 'save.exists')
  );

const signal = (id: string, event: string, payload: number): Op =>
  new Op(
    `signal(${id}, ${event}, ${payload})`,
    (store) => store.recordSignal(id, event, payload),
    (outcome) => {
      if (outcome.ok)
        return valueOf(outcome).found
          ? valueOf(outcome).resumed
            ? 'signal.resumed'
            : 'signal.recorded'
          : 'signal.unknown';
      return errorHas(outcome, 'already received') ? 'signal.duplicate' : 'signal.refused';
    }
  );

const park = (id: string, event: string, deadline: number | undefined): Op =>
  new Op(
    `park(${id}, ${event}, ${deadline === undefined ? 'no deadline' : `in ${deadline} ms`})`,
    (store, world) =>
      store.parkForSignal(id, event, deadline === undefined ? undefined : world.now() + deadline),
    (outcome) =>
      !outcome.ok
        ? 'park.badDeadline'
        : valueOf(outcome).parked
          ? 'park.parked'
          : valueOf(outcome).signalPresent
            ? 'park.signalPresent'
            : 'park.refused'
  );

const badPark = (id: string): Op =>
  new Op(
    `park(${id}, a, at 1.5 ms)`,
    (store) => store.parkForSignal(id, 'a', 1.5),
    (outcome) => (outcome.ok ? undefined : 'park.badDeadline')
  );

const expire = (id: string, event: string, node: number): Op =>
  new Op(
    `expire(${id}, ${event}, node ${node})`,
    async (store) => {
      const current = await store.get(id);
      if (!current) return 'missing';
      const failed: Execution = {
        ...current,
        state: 'failed',
        failureReason: 'waitFor timed out',
        steps: { ...current.steps, gate: { status: 'failed', error: 'timeout' } as never },
      };
      const outcome = await store.expireWait(failed, event, node);
      return { outcome, version: failed.version, updatedAt: failed.updatedAt };
    },
    (outcome) => {
      const kind = (valueOf(outcome).outcome as { kind?: string } | undefined)?.kind;
      return kind ? `expire.${kind}` : undefined;
    }
  );

const claim = (limit: number | undefined, leaseMs: number | undefined): Op =>
  new Op(
    `claimDueWaits(limit ${limit ?? 'default'}, lease ${leaseMs ?? 'default'} ms)`,
    (store) => store.claimDueWaits({ limit, leaseMs }),
    (outcome) =>
      outcome.ok && (outcome.value as unknown[]).length > 0 ? 'claim.some' : 'claim.none'
  );

const retire = (
  kind: 'cleanup' | 'archive',
  age: number,
  states: ExecutionState[] | undefined,
  limit: number | undefined
): Op =>
  new Op(
    `${kind}(older than ${age} ms, ${states ? `[${states}]` : 'default states'}, limit ${limit ?? 'default'})`,
    (store: WorkflowStorePort) => store[kind](age, states, limit),
    (outcome) => (outcome.ok && (outcome.value as number) > 0 ? `${kind}.some` : undefined)
  );

const restore = (id: string, event: string, node: number): Op =>
  new Op(
    `restoreSignalWait(${id}, ${event}, node ${node})`,
    (store) => store.restoreSignalWait(id, event, node),
    (outcome) => (outcome.ok ? `restore.${outcome.value}` : undefined)
  );

const remove = (id: string): Op => new Op(`remove(${id})`, (store) => store.remove(id));
/** Both stores read the one clock, so only the first of the two calls moves it. */
const advance = (ms: number): Op =>
  new Op(`advance(${ms} ms)`, async (store, world) => {
    if (store === world.real) world.clock.advance(ms);
    return ms;
  });

const id = fc.constantFrom(...IDS);
const event = fc.constantFrom(...EVENTS);
const node = fc.nat(2);
/** The node a gate sits at: most runs are still at the first. */
const gate = fc.constantFrom(0, 0, 0, 1);
const change = fc.record({
  state: fc.constantFrom(...STATES),
  node,
  failure: fc.constantFrom(undefined, 'boom'),
  step: fc.constantFrom('s1', 's2'),
});

/** Commands that move runs come up more often than the retention ones, which come up more than the odd ones. */
export const COMMANDS: Array<fc.Arbitrary<Op>> = [
  ...Array.from({ length: 3 }, () =>
    fc
      .tuple(id, fc.constantFrom(...NAMES), fc.option(id, { nil: undefined }))
      .map(([i, n, p]) => save(i, n, p === i ? undefined : p))
  ),
  ...Array.from({ length: 4 }, () =>
    fc.tuple(id, change, fc.boolean()).map(([i, c, s]) => update(i, c, s && c.node === 0))
  ),
  ...Array.from({ length: 3 }, () =>
    fc.tuple(id, event, fc.nat(9)).map(([i, e, p]) => signal(i, e, p))
  ),
  ...Array.from({ length: 3 }, () =>
    fc.tuple(id, event, fc.constantFrom(undefined, 0, 1000, 5000)).map(([i, e, d]) => park(i, e, d))
  ),
  id.map(badPark),
  ...Array.from({ length: 3 }, () => fc.tuple(id, event, gate).map(([i, e, n]) => expire(i, e, n))),
  ...Array.from({ length: 3 }, () =>
    fc.tuple(id, event, gate).map(([i, e, n]) => restore(i, e, n))
  ),
  ...Array.from({ length: 2 }, () =>
    fc
      .tuple(fc.constantFrom(undefined, 1, 2), fc.constantFrom(undefined, 1000, 5000))
      .map(([l, m]) => claim(l, m))
  ),
  ...Array.from({ length: 3 }, () => fc.constantFrom(1, 500, 1000, 5000, 4_000_000).map(advance)),
  ...(['cleanup', 'archive'] as const).map((kind) =>
    fc
      .tuple(
        fc.constantFrom(0, 1000, 5000),
        fc.constantFrom<ExecutionState[] | undefined>(
          undefined,
          ['completed'],
          ['completed', 'failed'],
          ['running'],
          []
        ),
        fc.constantFrom(undefined, 1, 2)
      )
      .map(([a, s, l]) => retire(kind, a, s, l))
  ),
  id.map(remove),
  ...QUERIES,
];
