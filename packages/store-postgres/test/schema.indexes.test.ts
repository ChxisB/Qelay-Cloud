import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { describeDb } from '../../../test/support/db';
import { migrate } from '../src/schema/migrate';
import type { FreshSchema } from './helpers';
import { freshSchema } from './helpers';
import { PLANNED } from './schema.planned';

interface PlanNode {
  'Node Type': string;
  'Index Name'?: string;
  'Total Cost'?: number;
  'Plan Rows'?: number;
  Plans?: PlanNode[];
}

const walk = (node: PlanNode): PlanNode[] => [node, ...(node.Plans ?? []).flatMap(walk)];

describeDb('schema indexes', () => {
  let fresh: FreshSchema;
  beforeAll(async () => {
    fresh = await freshSchema();
    await migrate(fresh.db);
    // A spread of states, groups, ttls and bells, so the planner works from real statistics.
    await fresh.sql.unsafe(`
      INSERT INTO qcloud_jobs (namespace, id, queue, payload, state, priority, lifo, run_at, rung_at,
                               created_at, ttl, unique_key, group_id, group_order, parent_id, lease_until)
      SELECT 'ns', 'j' || g, 'q', '\\x00'::bytea,
             (ARRAY['waiting', 'waiting', 'prioritized', 'delayed', 'active', 'completed', 'completed', 'failed'])[1 + g % 8],
             g % 5, g % 10 = 0, g, CASE WHEN g % 3 = 0 THEN NULL WHEN g % 3 = 1 THEN g ELSE 9000000 END,
             g, CASE WHEN g % 20 = 0 THEN 1000 END, CASE WHEN g % 7 = 0 THEN 'k' || g END,
             CASE WHEN g % 4 = 0 THEN 'g' || (g % 40) END, g, CASE WHEN g % 50 = 0 THEN 'p' || (g % 5) END,
             CASE WHEN g % 8 = 4 THEN g END
      FROM generate_series(1, 8000) g`);
    // Flow edges, so the guard's joins are planned for a table that has rows.
    await fresh.sql.unsafe(`
      INSERT INTO qcloud_dependencies (namespace, job_id, dependency_id)
      SELECT 'ns', 'j' || g, 'j' || (g + 1000) FROM generate_series(1, 400) g`);
    // Parents that wait for children, with their recorded failures and some completions, for the flow reads.
    await fresh.sql.unsafe(`
      INSERT INTO qcloud_jobs (namespace, id, queue, payload, state, priority, lifo, run_at, created_at)
      SELECT 'ns', 'p' || g, 'q', '\\x00'::bytea, 'waiting-children', 0, false, g, g
      FROM generate_series(10, 409) g`);
    await fresh.sql.unsafe(`
      INSERT INTO qcloud_flow_failures (namespace, parent_id, child_id, child_queue, mode, error, created_at)
      SELECT 'ns', 'p' || (g % 200 + 10), 'c' || g, 'q', (ARRAY['continue', 'ignore'])[1 + g % 2], 'boom', g
      FROM generate_series(1, 400) g`);
    await fresh.sql.unsafe(`
      INSERT INTO qcloud_completions (namespace, job_id, queue, completed_at, result)
      SELECT 'ns', 'j' || (g + 1000), 'r', g, '\\x00'::bytea FROM generate_series(1, 300) g`);
    // Flows (migration 7): 60 roots with 24 jobs each, three levels, for the flow views and actions.
    await fresh.sql.unsafe(`
      INSERT INTO qcloud_jobs (namespace, id, queue, payload, state, priority, lifo, run_at, created_at,
                               parent_id, flow_root, flow_depth)
      SELECT 'ns', CASE WHEN n = 0 THEN 'fr' || f ELSE 'fr' || f || '-' || n END, 'q', '\\x00'::bytea,
             (ARRAY['waiting-children', 'waiting', 'active', 'completed', 'failed'])[1 + (f + n) % 5],
             0, false, f, f * 100 + n,
             CASE WHEN n = 0 THEN NULL WHEN n <= 3 THEN 'fr' || f ELSE 'fr' || f || '-' || (1 + n % 3) END,
             'fr' || f, CASE WHEN n = 0 THEN 0 WHEN n <= 3 THEN 1 ELSE 2 END
      FROM generate_series(1, 60) f, generate_series(0, 23) n`);
    // Webhooks (migration 8): 40 of them with 8,000 deliveries between them, in every status.
    await fresh.sql.unsafe(`
      INSERT INTO qcloud_webhooks (namespace, id, url, created_by, created_at)
      SELECT 'ns', 'w' || g, 'https://hooks.example.com/' || g, 'op', g
      FROM generate_series(0, 39) g`);
    await fresh.sql.unsafe(`
      INSERT INTO qcloud_deliveries (namespace, webhook_id, event_id, event_name, queue, job_id,
                                             occurred_at, status, attempts, next_attempt_at, created_at,
                                             finished_at)
      SELECT 'ns', 'w' || (g % 40), g, 'request.received', 'q', 'j' || g, g * 1000, st, 1, g * 1000, g * 1000,
             CASE WHEN st IN ('delivered', 'failed') THEN g * 1000 END
      FROM (SELECT g, (ARRAY['pending', 'pending', 'sending', 'delivered', 'delivered', 'delivered',
                             'failed', 'pending'])[1 + g % 8] AS st
            FROM generate_series(1, 8000) g) s`);
    // Inbound sources (migration 20): 5 of them with 10 routes and 3,000 requests between them, interleaved with
    // another namespace's 30,000 and one quiet source, which is what makes the listings need their own indexes.
    await fresh.sql.unsafe(`
      INSERT INTO qcloud_sources (namespace, id, name, token_hash, created_by, created_at, updated_at)
      SELECT 'ns', 's' || g, 'Source ' || g, 'h' || g, 'op', g, g FROM generate_series(1, 5) g`);
    await fresh.sql.unsafe(`
      INSERT INTO qcloud_sources (namespace, id, name, token_hash, created_by, created_at, updated_at)
      VALUES ('other', 's1', 'Other', 'h1', 'op', 1, 1)`);
    await fresh.sql.unsafe(`
      INSERT INTO qcloud_webhooks (namespace, id, url, source_id, created_by, created_at)
      SELECT 'ns', 'sr' || g, 'https://hooks.example.com/s' || g, 's' || (1 + g % 5), 'op', g
      FROM generate_series(1, 10) g`);
    await fresh.sql.unsafe(`
      INSERT INTO qcloud_requests (namespace, source_id, received_at, method, status)
      SELECT CASE WHEN g % 11 = 0 THEN 'ns' ELSE 'other' END, CASE WHEN g % 11 > 0 THEN 's1' WHEN g % 330 = 0 THEN 's5' ELSE 's' || (1 + g % 4) END,
             g * 1000, 'POST', CASE WHEN g % 10 = 0 THEN 'rejected' ELSE 'accepted' END
      FROM generate_series(1, 33000) g`);
    // Workflow executions (migration 9): 12,000 runs of three workflows in every state, some of them
    // children, the waiting ones with deadlines; and 3,000 archived.
    await fresh.sql.unsafe(`
      INSERT INTO qcloud_workflow_executions
        (namespace, id, workflow_name, state, input, steps, current_node_index, signals, rollback_status,
         parent_execution_id, version, created_at, updated_at, wait_event, wait_deadline, definition_hash)
      SELECT 'ns', 'x' || g, (ARRAY['order', 'refund', 'ship'])[1 + g % 3], st, '\\x80'::bytea, '\\x80'::bytea,
             0, '\\x80'::bytea, CASE WHEN st = 'failed' AND g % 4 = 0 THEN 'completed' END,
             CASE WHEN g % 10 = 0 THEN 'x' || (g % 50) END, 0, g, g * 2,
             CASE WHEN st = 'waiting' THEN 'go' END, CASE WHEN st = 'waiting' AND g % 2 = 0 THEN g * 3 END,
             'h' || (g % 7)
      FROM (SELECT g, (ARRAY['completed', 'completed', 'completed', 'completed', 'failed', 'running',
                             'waiting', 'waiting', 'compensating', 'compensation-stuck'])[1 + g % 10] AS st
            FROM generate_series(1, 12000) g) s`);
    await fresh.sql.unsafe(`
      INSERT INTO qcloud_workflow_executions_archive
        (namespace, id, workflow_name, state, input, steps, current_node_index, signals, version,
         created_at, updated_at, archived_at)
      SELECT 'ns', 'a' || g, 'order', 'completed', '\\x80'::bytea, '\\x80'::bytea, 0, '\\x80'::bytea, 1,
             g, g, g * 2
      FROM generate_series(1, 3000) g`);
    // Workflow definitions (migration 10): 20 hashes of each of three workflows.
    await fresh.sql.unsafe(`
      INSERT INTO qcloud_workflow_definitions
        (namespace, name, hash, revision, graph, first_seen_at, last_seen_at)
      SELECT 'ns', (ARRAY['order', 'refund', 'ship'])[1 + g % 3], 'h' || g, 'r', '[]', g, g * 2
      FROM generate_series(1, 60) g`);
    for (const table of [
      'qcloud_jobs',
      'qcloud_dependencies',
      'qcloud_flow_failures',
      'qcloud_completions',
      'qcloud_webhooks',
      'qcloud_deliveries',
      'qcloud_sources',
      'qcloud_requests',
      'qcloud_workflow_executions',
      'qcloud_workflow_executions_archive',
      'qcloud_workflow_definitions',
    ]) {
      await fresh.sql.unsafe(`ANALYZE ${table}`);
    }
    // The visibility map is what lets the per-state counts be answered from an index alone.
    await fresh.sql.unsafe('VACUUM qcloud_workflow_executions');
  });
  afterAll(async () => {
    await fresh?.drop();
  });

  // Sequential scans are off for every plan. For an ordered query sorts and bitmap scans are off
  // too, so the plan shows whether the index can deliver the order and not only whether it can find
  // the rows: on a small table a sort over a bitmap scan is a fair choice, and not what is tested.
  // A partitioned table's plan names the index of each partition: this maps it to the parent's.
  let parentIndex = new Map<string, string>();
  beforeAll(async () => {
    const rows = await fresh.sql<Array<{ child: string; parent: string }>>`
      SELECT c.relname::text AS child, p.relname::text AS parent
      FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid JOIN pg_class p ON p.oid = i.inhparent
      WHERE c.relkind = 'i' AND c.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = ${fresh.name})`;
    parentIndex = new Map(rows.map((row) => [row.child, row.parent]));
  });

  const plan = async (
    text: string,
    ordered = false,
    params: readonly unknown[] = []
  ): Promise<PlanNode[]> =>
    fresh.sql.begin(async (tx) => {
      await tx.unsafe('SET LOCAL enable_seqscan = off');
      if (ordered) {
        await tx.unsafe('SET LOCAL enable_sort = off');
        await tx.unsafe('SET LOCAL enable_bitmapscan = off');
      }
      const [row] = await tx.unsafe(`EXPLAIN (FORMAT JSON) ${text}`, [...params]);
      const raw = row!['QUERY PLAN'];
      const parsed = (typeof raw === 'string' ? JSON.parse(raw) : raw) as Array<{ Plan: PlanNode }>;
      return walk(parsed[0]!.Plan);
    });

  describe.each(PLANNED.map((entry) => [entry.query, entry] as const))('%s', (_name, entry) => {
    test(`is served by ${entry.index}`, async () => {
      const nodes = await plan(entry.sql, entry.ordered, entry.params);
      // QCLOUD_PRINT_PLANS=<text> prints the plan of every query whose name contains it.
      const printed = process.env.QCLOUD_PRINT_PLANS;
      if (printed && entry.query.includes(printed)) {
        const steps = nodes.map(
          (n) => `${n['Node Type']}${n['Index Name'] ? ` [${n['Index Name']}]` : ''}`
        );
        console.log(
          `PLAN ${entry.query}\n  ${steps.join(' > ')}\n  cost ${nodes[0]!['Total Cost']}, rows ${nodes[0]!['Plan Rows']}`
        );
      }
      const used = [
        ...new Set(
          nodes.flatMap((node) =>
            node['Index Name'] ? [parentIndex.get(node['Index Name']) ?? node['Index Name']] : []
          )
        ),
      ];
      const wanted = [entry.index, ...(entry.alternatives ?? [])];
      if (!wanted.some((name) => used.includes(name))) expect(used).toContain(entry.index);
      for (const name of entry.avoid ?? []) expect(used).not.toContain(name);
      if (entry.ordered) expect(nodes.map((node) => node['Node Type'])).not.toContain('Sort');
    });
  });

  test('every index is served by a planned query, so none is dead weight', async () => {
    const rows = await fresh.sql<Array<{ name: string }>>`
      SELECT c.relname::text AS name FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
      WHERE c.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = ${fresh.name})
        AND NOT i.indisprimary AND NOT c.relispartition
        -- The old delivery table (versions 8 to 12): nothing reads it, and the release after 13 drops it.
        AND c.relname NOT LIKE 'qcloud\_webhook\_deliveries\_%'`;
    const planned = new Set(PLANNED.map((entry) => entry.index));
    const unused = rows.map((row) => row.name).filter((name) => !planned.has(name));
    expect(unused).toEqual([]);
  });
});
