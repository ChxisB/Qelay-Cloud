// Verbatim copy of `JobFull`, `QueueCountsFull` and `QueueSummaryFull` (lines 1-72) of
// `src/lib/bqTypes.ts` from ../qelay-control-panel (MIT, see docs/PORTING.md), taken so the contract
// tests can check what the Control API sends for jobs and queues against what the panel reads. Do
// not edit it: when task 33 exists the panel's types come from a shared package and this file is
// deleted.
//
//   panel commit:  8ebf9328950a23a2f2687115a0ec15e66b7659bd (2026-10-09)
//   sha256 of the copied lines: df5772d1e4db68c19f635d0cf725f10024c008db9dc728b3c9553b2508e0f027
//   The panel's working tree differed from that commit in two comments only (the product name, renamed).
//
export interface JobFull {
  id: string;
  queue?: string;
  /** First-class job name (Qelay protocol v3 / v2.9.3). */
  name?: string;
  data?: unknown;
  /** Terminal value embedded by current job read/list endpoints. */
  returnvalue?: unknown;
  /** Most recent terminal failure message embedded by current job reads. */
  failedReason?: string;
  /** Legacy dashboard alias; new code should prefer returnvalue. */
  result?: unknown;
  priority?: number;
  createdAt?: number;
  runAt?: number;
  startedAt?: number | null;
  completedAt?: number | null;
  attempts?: number;
  maxAttempts?: number;
  backoff?: number;
  backoffConfig?: { type: 'fixed' | 'exponential'; delay: number; maxDelay?: number } | null;
  timeout?: number | null;
  ttl?: number | null;
  progress?: number;
  progressMessage?: string | null;
  stacktrace?: string[] | null;
  customId?: string | null;
  parentId?: string | null;
  childrenIds?: string[];
  dependsOn?: string[];
  tags?: string[];
  groupId?: string | null;
  removeOnComplete?: boolean;
  removeOnFail?: boolean;
  lastHeartbeat?: number;
  stallCount?: number;
  state?: string;
  timeline?: Array<{
    state: string;
    timestamp: number;
    worker?: string;
    error?: string;
    attempt?: number;
  }>;
  [key: string]: unknown;
}

export interface QueueCountsFull {
  waiting: number;
  prioritized: number;
  delayed: number;
  active: number;
  completed: number;
  failed: number;
  'waiting-children': number;
  paused: number;
  [key: string]: number;
}

/** One entry of GET /queues/summary — all queues' counts in a single call. */
export interface QueueSummaryFull {
  name: string;
  paused: boolean;
  counts: {
    waiting: number;
    prioritized: number;
    active: number;
    completed: number;
    failed: number;
    delayed: number;
  };
}
