import { expect } from 'bun:test';
import { FaultyTransport } from '../support/faults/faultyTransport';
import type { Scenario } from './scenario';
import { Ledger, reconcile, untilFinished } from './scenario';
import type { Stack } from './stack';
import { QUEUE } from './stack';

/** The queue the children of a flow run in, so that a parent and its children are in different queues. */
const PARTS = 'parts';
const STACK = { queues: [QUEUE, PARTS] } as const;

const bellFor = (s: Stack, queue: string, jobId?: string) => ({
  bell: { namespace: s.namespace, queue, ...(jobId === undefined ? {} : { jobId }) },
});

/** Flows on every transport: the parent is the job that must not run early, twice or never. */
export const flowScenarios: readonly Scenario[] = [
  {
    name: 'flow: the parent runs once, after every child, whatever bells arrive, and reads what they returned',
    stack: STACK,
    async run(s) {
      const ledger = new Ledger();
      const finishedAt = new Map<string, number>();
      const startedAt = new Map<string, number>();
      const read: Array<{
        values: Record<string, unknown>;
        processed: number;
        unprocessed: number;
      }> = [];
      const work = async (job: {
        id: string;
        name: string;
        data: unknown;
        attemptsMade: number;
        getChildrenValues(): Promise<Record<string, unknown>>;
        getDependencies(): Promise<{ processed: object; unprocessed: readonly string[] }>;
      }) => {
        ledger.record(job.id, job.attemptsMade);
        startedAt.set(job.id, Date.now());
        await Bun.sleep(60);
        if (job.name === 'report') {
          const deps = await job.getDependencies();
          read.push({
            values: await job.getChildrenValues(),
            processed: Object.keys(deps.processed).length,
            unprocessed: deps.unprocessed.length,
          });
          return 'report done';
        }
        finishedAt.set(job.id, Date.now());
        return `part ${String(job.data)}`;
      };
      s.worker(work, { concurrency: 3 }, QUEUE);
      s.worker(work, { concurrency: 3 }, PARTS);
      const tree = await s.flows().add({
        name: 'report',
        queueName: QUEUE,
        children: [
          { name: 'part', queueName: PARTS, data: 1 },
          { name: 'part', queueName: PARTS, data: 2 },
          {
            name: 'group',
            queueName: PARTS,
            data: 'g',
            children: [{ name: 'part', queueName: PARTS, data: 3 }],
          },
        ],
      });
      const parent = tree.job.id;
      const partIds = [
        tree.children![0]!.job.id,
        tree.children![1]!.job.id,
        tree.children![2]!.job.id,
        tree.children![2]!.children![0]!.job.id,
      ];
      const ids = [parent, ...partIds];
      // Three more bells for every job of the flow, the parent's included: it is still waiting for its
      // children when they arrive, and what they find must be nothing to run.
      const rings = ids.flatMap((id) => {
        const queue = id === parent ? QUEUE : PARTS;
        return [bellFor(s, queue, id), bellFor(s, queue, id), bellFor(s, queue, id)];
      });
      expect((await s.ring.ring(rings)).every((result) => result.ok)).toBe(true);
      await untilFinished(s, ids);
      // Time for a late duplicate of the parent's own bell to arrive and claim nothing.
      expect((await s.ring.ring(rings)).every((result) => result.ok)).toBe(true);
      await Bun.sleep(900);
      for (const id of ids) expect(ledger.count(id)).toBe(1);
      for (const id of partIds) {
        expect(startedAt.get(parent)!).toBeGreaterThanOrEqual(finishedAt.get(id)!);
      }
      expect(read).toEqual([
        {
          values: Object.fromEntries(
            [tree.children![0]!, tree.children![1]!, tree.children![2]!].map((node) => [
              `${node.job.queueName}:${node.job.id}`,
              expect.any(String),
            ])
          ),
          processed: 3,
          unprocessed: 0,
        },
      ]);
      expect(await s.states()).toEqual({ completed: 5 });
      await reconcile(s, ids);
    },
  },
  {
    name: 'flow: a child that fails with failParentOnFailure fails the parent, which never runs, and other children finish',
    stack: STACK,
    async run(s) {
      const ledger = new Ledger();
      const work = (job: { id: string; name: string; attemptsMade: number }) => {
        ledger.record(job.id, job.attemptsMade);
        if (job.name === 'doomed') throw new Error('boom');
        return 'ok';
      };
      s.worker(work, {}, QUEUE);
      s.worker(work, {}, PARTS);
      const tree = await s.flows().add({
        name: 'report',
        queueName: QUEUE,
        children: [
          {
            name: 'doomed',
            queueName: PARTS,
            opts: { attempts: 1, failParentOnFailure: true },
          },
          { name: 'fine', queueName: PARTS },
        ],
      });
      const ids = [tree.job.id, ...tree.children!.map((node) => node.job.id)];
      await untilFinished(s, ids);
      // Duplicates of the dead parent's bell, after it failed: nothing to claim.
      await s.ring.ring([bellFor(s, QUEUE, tree.job.id), bellFor(s, QUEUE, tree.job.id)]);
      await Bun.sleep(500);
      expect(ledger.count(tree.job.id)).toBe(0);
      const states = await reconcile(s, ids);
      expect(states.get(tree.job.id)).toMatchObject({ state: 'failed' });
      expect(await tree.job.getState()).toBe('failed');
      const failed = (await s.queue().getJob(tree.job.id))!.failedReason;
      expect(failed).toBe(`Child job ${tree.children![0]!.job.id} failed: boom`);
      expect(states.get(tree.children![1]!.job.id)).toMatchObject({ state: 'completed' });
    },
  },
  {
    name: 'flow: a child that fails with continueParentOnFailure lets the parent run and read the failure',
    stack: STACK,
    async run(s) {
      const ledger = new Ledger();
      let failures: Record<string, string> = {};
      const work = async (job: {
        id: string;
        name: string;
        attemptsMade: number;
        getFailedChildrenValues(): Promise<Record<string, string>>;
      }) => {
        ledger.record(job.id, job.attemptsMade);
        if (job.name === 'doomed') throw new Error('flaky source');
        if (job.name === 'report') failures = await job.getFailedChildrenValues();
        return 'ok';
      };
      s.worker(work, {}, QUEUE);
      s.worker(work, {}, PARTS);
      const tree = await s.flows().add({
        name: 'report',
        queueName: QUEUE,
        children: [
          {
            name: 'doomed',
            queueName: PARTS,
            opts: { attempts: 1, continueParentOnFailure: true },
          },
        ],
      });
      const ids = [tree.job.id, tree.children![0]!.job.id];
      await untilFinished(s, ids);
      expect(ledger.count(tree.job.id)).toBe(1);
      expect(failures).toEqual({ [`${PARTS}:${ids[1]}`]: 'flaky source' });
      const states = await reconcile(s, ids);
      expect(states.get(ids[0]!)).toMatchObject({ state: 'completed' });
      expect(states.get(ids[1]!)).toMatchObject({ state: 'failed' });
    },
  },
  {
    name: 'flow: a lost bell for the promoted parent is rung again by the tick, and the parent runs once',
    stack: { ...STACK, ringGraceMs: 100 },
    async run(s) {
      const ledger = new Ledger();
      const work = (job: { id: string; attemptsMade: number }) =>
        void ledger.record(job.id, job.attemptsMade);
      // The only ring this worker makes is the parent's, when the last child completes; it fails.
      const workerRing = new FaultyTransport(s.transport());
      workerRing.failNext(1);
      s.worker(work, { transport: workerRing, closeTransport: s.kind !== 'memory' }, PARTS);
      s.worker(work, {}, QUEUE);
      const tree = await s.flows().add({
        name: 'report',
        queueName: QUEUE,
        children: [{ name: 'part', queueName: PARTS }],
      });
      const ids = [tree.job.id, tree.children![0]!.job.id];
      await untilFinished(s, ids, 20_000);
      // The bell that was lost is the proof that the tick, not the completing worker, delivered this one.
      expect(workerRing.calls.failed).toBe(1);
      await Bun.sleep(600);
      for (const id of ids) expect(ledger.count(id)).toBe(1);
      await reconcile(s, ids);
    },
  },
];
