import type { Bell, Clock, StateStore } from '@qelay-cloud/core';

/**
 * The harness drives the real `StateStore` from `@qelay-cloud/core` (task 10). This module
 * re-exports the shapes it uses, and adds only what is harness-specific: the environment a
 * target is built with, and the factory type.
 */
export type {
  Bell,
  ClaimedJob,
  Clock,
  DlqEntry,
  DlqRetryManyOptions,
  DlqRetryManyResult,
  DlqRetryResult,
  EnqueuedJob,
  FailureInfo,
  JobRecord,
  JobState,
  Lease,
  NewJob,
  Outcome,
  Ring,
  StateStore,
  TickBudget,
  TickReport,
} from '@qelay-cloud/core';

/** What the harness calls a bell in commands and the in-memory broker. */
export type Doorbell = Bell;

export interface StoreEnv {
  readonly clock: Clock;
  readonly namespace: string;
  readonly lockTtlMs: number;
  /** `tick` rings a claimable job again once its last doorbell is at least this old. */
  readonly reRingAfterMs: number;
}

export type StoreFactory = (env: StoreEnv) => Promise<StateStore>;
