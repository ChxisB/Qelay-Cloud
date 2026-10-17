import { describe } from 'bun:test';
import { crudContract } from './crud';
import type { OpenWorkflowStore } from './fixtures';
import { useHarness } from './fixtures';
import { insightContract } from './insight';
import { listsContract } from './lists';
import { retentionContract } from './retention';
import { signalsContract } from './signals';
import { waitsContract } from './waits';

export { execution, ids, moveTo, seed, T0 } from './fixtures';
export type { OpenWorkflowStore, WorkflowHarness } from './fixtures';

/**
 * What every workflow store must do, in one suite: the in-memory reference and the Postgres store
 * both run it, so they cannot drift. The Postgres-only tests (races, indexes, limits) live beside it.
 */
export function workflowStoreContract(name: string, open: OpenWorkflowStore): void {
  describe(`${name}: workflow store contract`, () => {
    const h = useHarness(open);
    crudContract(h);
    signalsContract(h);
    waitsContract(h);
    listsContract(h);
    retentionContract(h);
    insightContract(h);
  });
}
