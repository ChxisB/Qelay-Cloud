/** What a compensation pass needs from the engine that drives it. */

import type { Clock } from './clock';
import type { WorkflowEmitter } from './emitter';
import type { RunStorage } from './storage';
import type { Workflow } from './workflow';

export interface CompensationEnv {
  storage: RunStorage;
  emitter: WorkflowEmitter | null;
  clock: Clock;
  /** Needed to roll a sub-workflow back; absent only in isolated runner tests. */
  workflows?: ReadonlyMap<string, Workflow>;
  assertActive: () => void;
}
