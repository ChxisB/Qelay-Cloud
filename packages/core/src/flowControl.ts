import type { FlowFailureMode } from './flow';
import type { JobState, Ring } from './jobs';

/** Jobs of one flow `FlowView` lists when the caller names no limit. A flow is at most `MAX_FLOW_JOBS`. */
export const DEFAULT_FLOW_VIEW_NODES = 1_000;
/** Most jobs one `FlowView` lists. A flow written before a limit change, or by hand, can be larger. */
export const MAX_FLOW_VIEW_NODES = 5_000;
/** Longest failure message a `FlowViewNode` carries, in characters. */
export const FLOW_VIEW_ERROR_CHARS = 500;

/** One flow in the list of flows: its root and how its jobs are doing. */
export interface FlowRootSummary {
  readonly id: string;
  readonly queue: string;
  /** The job's name, or null when it could not be read. */
  readonly name: string | null;
  readonly state: JobState;
  readonly createdAt: number;
  readonly version: number;
  /** Jobs of the flow that are stored now. A child removed when it completed is not counted. */
  readonly total: number;
  /** Stored jobs by state. */
  readonly states: Readonly<Partial<Record<JobState, number>>>;
  /** Failed children that hold a waiting parent back: the flow is stuck until an operator acts. */
  readonly blocked: number;
}

export interface FlowRootsPage {
  readonly items: readonly FlowRootSummary[];
  /** Flows in the namespace, not in the page. */
  readonly total: number;
}

/** One job of a flow as the control API shows it. */
export interface FlowViewNode {
  readonly id: string;
  readonly queue: string;
  readonly state: JobState;
  /** The row's version, for `expectedVersion`. Null for a child only its completion record is left of. */
  readonly version: number | null;
  readonly parentId: string | null;
  /** Levels below the root: the root is 0. */
  readonly depth: number;
  readonly attempts: number;
  readonly createdAt: number | null;
  readonly completedAt: number | null;
  /** The message of the failure, cut to `FLOW_VIEW_ERROR_CHARS`; null for a job that did not fail. */
  readonly error: string | null;
  /** What this job's failure does to its parent (the policy on its edge), or null when it sets none. */
  readonly mode: FlowFailureMode | null;
  /** The job failed and its parent still waits for it: the parent is held back until an operator acts. */
  readonly blocking: boolean;
  /** The job was removed when it completed: only its completion record is left. */
  readonly removed: boolean;
}

/** A failure a parent keeps for its processor to read (`continue` and `ignore`). */
export interface FlowFailureRecord {
  readonly parentId: string;
  readonly childId: string;
  readonly queue: string;
  readonly mode: 'continue' | 'ignore';
  readonly error: string;
}

/** One flow as it is now. */
export interface FlowView {
  readonly root: string;
  /** Top level first (every job comes after its parent), then by id. */
  readonly nodes: readonly FlowViewNode[];
  /** Jobs of the flow that are stored now, whether or not they are in `nodes`. */
  readonly total: number;
  /** `nodes` is a part of the flow: `limit` ran out. */
  readonly truncated: boolean;
  readonly limit: number;
  /** The failures the jobs in `nodes` kept for the parents in `nodes`, at most `limit` of them. */
  readonly failures: readonly FlowFailureRecord[];
}

/** What an operator can do to a flow, as a whole. */
export type FlowActionName = 'retry-failed' | 'promote' | 'remove';

/** A job an action touches, with the version the caller saw. */
export interface FlowJobVersion {
  readonly id: string;
  readonly expectedVersion: number;
}

export interface FlowActionRequest {
  readonly action: FlowActionName;
  /** The jobs the action touches, each with the version it was read at. */
  readonly jobs: readonly FlowJobVersion[];
  /** `promote`: the waiting parent to let go of the failed children that hold it back. */
  readonly parent?: string;
}

/** Why an action did nothing. Every refusal leaves the flow as it was. */
export type FlowRefusal =
  /** No flow has this root: there is no such job, or it is not the root of a flow. */
  | { readonly kind: 'not_found' }
  /** The flow has more jobs than an action reads. */
  | { readonly kind: 'too_large'; readonly limit: number }
  /** The action touches jobs the request has no version for: the flow is not what the caller saw. */
  | { readonly kind: 'unseen'; readonly ids: readonly string[] }
  /** `jobs` names jobs the action does not touch, or that are not in the flow. */
  | { readonly kind: 'foreign'; readonly ids: readonly string[] }
  /** `remove`: jobs of the flow are running. */
  | { readonly kind: 'active'; readonly ids: readonly string[] }
  /** `retry-failed`: jobs that are not failed children holding a waiting parent back. */
  | { readonly kind: 'not_retryable'; readonly ids: readonly string[] }
  /** `promote`: the parent is not waiting, or children that are not failed still hold it. */
  | {
      readonly kind: 'not_stuck';
      readonly reason: 'not_waiting' | 'nothing_blocks' | 'children_unfinished';
      readonly ids: readonly string[];
    };

/** One job an action changed. `to` is `removed` for a job the action deleted. */
export interface FlowChange {
  readonly id: string;
  readonly queue: string;
  readonly from: JobState;
  readonly to: JobState | 'removed';
}

export type FlowActionResult =
  | {
      readonly applied: true;
      readonly changes: readonly FlowChange[];
      readonly rings: readonly Ring[];
    }
  | { readonly applied: false; readonly refusal: FlowRefusal };
