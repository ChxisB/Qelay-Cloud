import { MemoryWorkflowStore } from '../../packages/core/src';
import { ManualClock } from '../support/clock';
import { T0, workflowStoreContract } from '../support/workflow';
import type { WorkflowHarness } from '../support/workflow';

workflowStoreContract('MemoryWorkflowStore', async (): Promise<WorkflowHarness> => {
  const clock = new ManualClock(T0);
  let store = new MemoryWorkflowStore(clock);
  return {
    get store() {
      return store;
    },
    clock,
    async reset() {
      store = new MemoryWorkflowStore(clock);
      clock.advance(T0 - clock.now());
    },
    async close() {},
  };
});
