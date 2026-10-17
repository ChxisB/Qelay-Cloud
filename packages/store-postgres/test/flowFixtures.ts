import type { TestStore } from './storeHelpers';
import { enqueueN } from './storeHelpers';

export interface Flow {
  readonly parent: string;
  readonly children: readonly string[];
}

/**
 * A flow parent waiting on children, written the way task 50's flow admission will write it: the
 * parent is `waiting-children`, each child names it in `parent_id`, and `qcloud_dependencies` has an
 * edge from the parent to each child. Flows are not enqueued through the store yet, so the rows
 * are made directly; what is under test is how the destructive actions read them.
 */
export async function makeFlow(
  t: TestStore,
  options: { parentQueue?: string; childQueue?: string; children?: number } = {}
): Promise<Flow> {
  const { parentQueue = 'flows', childQueue = 'q', children = 1 } = options;
  const [parent] = await enqueueN(t.store, 1, {}, parentQueue);
  const kids = await enqueueN(t.store, children, {}, childQueue);
  await t.fresh.sql`UPDATE qcloud_jobs SET state = 'waiting-children' WHERE id = ${parent!}`;
  for (const child of kids) {
    await t.fresh.sql`UPDATE qcloud_jobs SET parent_id = ${parent!} WHERE id = ${child}`;
    await t.fresh.sql`
      INSERT INTO qcloud_dependencies (namespace, job_id, dependency_id)
      VALUES ('test', ${parent!}, ${child})`;
  }
  return { parent: parent!, children: kids };
}

/** The ids still in the table, optionally of one queue, sorted. */
export async function remainingIds(t: TestStore, queue?: string): Promise<string[]> {
  const rows = queue
    ? await t.fresh.sql<Array<{ id: string }>>`
        SELECT id FROM qcloud_jobs WHERE queue = ${queue} ORDER BY id`
    : await t.fresh.sql<Array<{ id: string }>>`SELECT id FROM qcloud_jobs ORDER BY id`;
  return rows.map((row) => row.id);
}
