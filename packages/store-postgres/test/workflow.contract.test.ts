import { describeDb } from '../../../test/support/db';
import type { WorkflowHarness } from '../../../test/support/workflow';
import { T0, workflowStoreContract } from '../../../test/support/workflow';
import { openTestStore } from './storeHelpers';

/** The same suite the in-memory store runs: the two stores have to agree command by command. */
describeDb('PostgresStore.workflows', () => {
  workflowStoreContract('PostgresStore.workflows', async (): Promise<WorkflowHarness> => {
    const t = await openTestStore();
    return {
      store: t.store.workflows,
      clock: t.clock,
      async reset() {
        await t.fresh.sql`TRUNCATE qcloud_workflow_executions, qcloud_workflow_executions_archive,
          qcloud_workflow_definitions`;
        t.clock.advance(T0 - t.clock.now());
      },
      close: () => t.drop(),
    };
  });
});
