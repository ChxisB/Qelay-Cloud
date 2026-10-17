import type { FlatFlowNode } from '@qelay-cloud/core';
import { FlowError } from '@qelay-cloud/core';
import { createdNodes, loadNodes, planFlow } from './flowBuild';
import type { FlowJob, FlowOpts, FlowProducerOptions, GetFlowOpts, JobNode } from './flowTypes';
import { ringAfterCommit } from './ring';
import type { Runtime } from './runtime';
import { openRuntime } from './runtime';

// Adapted from Qelay's `src/client/flow.ts` (see docs/PORTING.md).

/**
 * Adds flows: a parent job that waits for its children, which may be parents themselves, in any
 * queues of the namespace. Qelay's `FlowProducer` over Postgres: a flow is written in one transaction,
 * so either all of its jobs exist or none do, and its parent is never claimable before its last child
 * is done. `docs/compat.md` lists what is supported and what differs.
 *
 * ```ts
 * const flows = new FlowProducer({ databaseUrl, transport });
 * const { job } = await flows.add({
 *   name: 'report',
 *   queueName: 'reports',
 *   children: [
 *     { name: 'fetch', queueName: 'fetch', data: { id: 1 }, opts: { failParentOnFailure: true } },
 *     { name: 'fetch', queueName: 'fetch', data: { id: 2 }, opts: { ignoreDependencyOnFailure: true } },
 *   ],
 * });
 * ```
 *
 * The parent's processor reads what its children produced with `getChildrenValues`,
 * `getDependencies`, `getFailedChildrenValues` and `getIgnoredChildrenFailures` of its job.
 */
export class FlowProducer {
  readonly #rt: Runtime;

  /** Opens nothing: the connection is made by the first call. Throws `UnsupportedOptionError` for an option this package does not support. */
  constructor(options: FlowProducerOptions) {
    this.#rt = openRuntime('flow-producer', options);
  }

  /** Resolves when the database answers and holds a migrated schema; rejects with the cause otherwise. */
  async waitUntilReady(): Promise<void> {
    await this.#rt.store.counts(this.#rt.name);
  }

  /**
   * Adds one flow and resolves with its jobs, shaped like the input. Rejects with `FlowError` for a
   * flow that cannot be written, and nothing is written then. A flow whose root has a custom id that is
   * live is not added again: the live flow is returned, its root marked `duplicated`. Every other custom
   * id of the flow must be free.
   */
  async add<T = unknown, R = unknown>(flow: FlowJob<T>, opts?: FlowOpts): Promise<JobNode<T, R>> {
    const [node] = await this.addBulk([flow], opts);
    return node as JobNode<T, R>;
  }

  /**
   * Adds several flows, each in its own transaction, in order, and resolves with their nodes. Every flow
   * is checked before the first is written, so a malformed one rejects the call with nothing added. A
   * failure after that (the database going away, a custom id that is taken) leaves the flows before it
   * added: the call is not atomic across flows. Submitting the same flows again is safe when their roots
   * have custom ids.
   */
  async addBulk(flows: ReadonlyArray<FlowJob>, opts?: FlowOpts): Promise<JobNode[]> {
    const plans = flows.map((flow) => planFlow(flow, this.#rt, opts));
    const added: JobNode[] = [];
    for (const plan of plans) added.push(await this.#write(plan));
    return added;
  }

  /**
   * The flow under a job as it is now, to `depth` levels and `maxChildren` per job, or null when no job has
   * that id in that queue. A child that was removed when it completed is not listed.
   */
  async getFlow<T = unknown>(opts: GetFlowOpts): Promise<JobNode<T> | null> {
    const limits = {
      ...(opts.depth !== undefined && { depth: opts.depth }),
      ...(opts.maxChildren !== undefined && { maxChildren: opts.maxChildren }),
    };
    const tree = await this.#rt.store.flows.tree(opts.id, limits);
    if (tree === null || tree.queue !== opts.queueName) return null;
    return (await loadNodes(this.#rt, tree, false)) as JobNode<T> | null;
  }

  /**
   * Closes the connections this producer opened (not a store that was passed in, never the transport).
   * Idempotent. Pending calls finish or reject.
   */
  close(options?: { readonly timeout?: number }): Promise<void> {
    return this.#rt.close(options);
  }

  /** The same as `close`, for code written against Qelay's `disconnect`. */
  disconnect(): Promise<void> {
    return this.close();
  }

  async #write(plan: readonly FlatFlowNode[]): Promise<JobNode> {
    const rt = this.#rt;
    const added = await rt.store.flows.add(plan);
    if (!added.created) {
      const tree = await rt.store.flows.tree(added.root.id);
      const node = tree === null ? null : await loadNodes(rt, tree, true);
      if (node !== null) return node;
      throw new FlowError(
        `flow "${added.root.id}" was added by an earlier call and is gone: it finished and was removed before it could be read`
      );
    }
    const now = Date.now();
    await ringAfterCommit(
      rt,
      added.jobs.flatMap((job) => (job.ring === null ? [] : [job.ring]))
    );
    return createdNodes(rt, plan, added.jobs, now);
  }
}
