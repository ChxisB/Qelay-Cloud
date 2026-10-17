import type { FlowJobOptions, JobOptions } from '@qelay-cloud/core';
import type { Job } from './job';
import type { QueueOptions } from './options';

// Adapted from Qelay's `src/client/flowTypes.ts` (see docs/PORTING.md).

/**
 * One job of a flow and the jobs that must finish before it runs, in Qelay's shape (`FlowJob`). A child
 * sets what its failure does to its parent through the options `failParentOnFailure`,
 * `continueParentOnFailure`, `ignoreDependencyOnFailure` and `removeDependencyOnFailure`.
 */
export interface FlowJob<T = unknown> {
  readonly name: string;
  readonly queueName: string;
  readonly data?: T;
  readonly opts?: FlowJobOptions;
  readonly children?: ReadonlyArray<FlowJob>;
}

/** A job of an added or read flow, with the nodes of its children. `children` is absent for a leaf. */
export interface JobNode<T = unknown, R = unknown> {
  readonly job: Job<T, R>;
  readonly children?: ReadonlyArray<JobNode>;
}

/** Per-call options of `FlowProducer.add` and `addBulk`. */
export interface FlowOpts {
  /** `defaultJobOptions` for the jobs of one queue, merged over the producer's and under each job's own. */
  readonly queuesOptions?: Readonly<Record<string, { readonly defaultJobOptions?: JobOptions }>>;
}

/** What `FlowProducer.getFlow` reads. */
export interface GetFlowOpts {
  readonly id: string;
  readonly queueName: string;
  /** Levels read below the root: 0 reads the root alone. Default: the whole flow. */
  readonly depth?: number;
  /** Children read per job. Default: all. */
  readonly maxChildren?: number;
}

/** A `FlowProducer` is built from what a `Queue` is: a database, a doorbell and a namespace. */
export type FlowProducerOptions = QueueOptions;
