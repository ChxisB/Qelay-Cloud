import { expect } from 'bun:test';
import type { Statement } from '../src/store/readQueries';
import type { FreshSchema } from './helpers';

export interface PlanNode {
  'Node Type': string;
  'Relation Name'?: string;
  'Index Name'?: string;
  'Actual Rows'?: number;
  'Rows Removed by Filter'?: number;
  Plans?: PlanNode[];
}

const walk = (node: PlanNode): PlanNode[] => [node, ...(node.Plans ?? []).flatMap(walk)];

export interface Planned {
  readonly name: string;
  readonly statement: Statement;
  /** Indexes the plan must read, whatever else it adds. */
  readonly indexes: readonly string[];
  /** The plan must read at least one of these: the planner may pick either of two good plans. */
  readonly oneOf?: readonly string[];
  /** The index delivers the order, so the plan has no Sort. */
  readonly ordered?: boolean;
  /**
   * Plan with sequential scans off. For a table with one row per queue, where reading all of a
   * namespace's rows is a fair choice for the planner and is bounded by the queue count; the check
   * is then that an index can serve the statement.
   */
  readonly forceIndex?: boolean;
  /** A statement that writes: planned without being run (no ANALYZE). */
  readonly writes?: boolean;
}

/** The plan of a statement, flattened. Run with ANALYZE unless it writes. */
export async function explain(
  fresh: FreshSchema,
  { text, params }: Statement,
  options: { forceIndex?: boolean; writes?: boolean } = {}
): Promise<PlanNode[]> {
  return fresh.sql.begin(async (tx) => {
    if (options.forceIndex) await tx.unsafe('SET LOCAL enable_seqscan = off');
    const analyze = options.writes ? '' : 'ANALYZE, ';
    const [row] = await tx.unsafe(`EXPLAIN (${analyze}FORMAT JSON) ${text}`, [...params]);
    const raw = row!['QUERY PLAN'];
    const parsed = (typeof raw === 'string' ? JSON.parse(raw) : raw) as Array<{ Plan: PlanNode }>;
    return walk(parsed[0]!.Plan);
  });
}

export const summary = (nodes: PlanNode[]): string =>
  nodes
    .filter((node) => node['Relation Name'] || node['Index Name'] || node['Node Type'] === 'Sort')
    .map((node) => `${node['Node Type']}${node['Index Name'] ? ` on ${node['Index Name']}` : ''}`)
    .join(' > ');

/** The most entries any read of `relation` visited: the rows it returned plus those its filter dropped. */
export const visited = (nodes: PlanNode[], relation: string): number =>
  Math.max(
    ...nodes
      .filter((node) => node['Relation Name'] === relation)
      .map((node) => (node['Actual Rows'] ?? 0) + (node['Rows Removed by Filter'] ?? 0))
  );

/** Plans the statement and checks it reads the indexes it must and scans no table sequentially. */
export async function checkPlanned(fresh: FreshSchema, entry: Planned): Promise<PlanNode[]> {
  const nodes = await explain(fresh, entry.statement, {
    forceIndex: entry.forceIndex ?? false,
    writes: entry.writes ?? false,
  });
  if (process.env.QCLOUD_PRINT_PLANS) console.log(`PLAN ${entry.name}: ${summary(nodes)}`);
  const used = new Set(nodes.flatMap((node) => (node['Index Name'] ? [node['Index Name']] : [])));
  for (const index of entry.indexes) expect(used).toContain(index);
  if (entry.oneOf) expect(entry.oneOf.some((index) => used.has(index))).toBe(true);
  const scans = nodes.filter((node) => node['Node Type'] === 'Seq Scan');
  expect(scans.map((node) => node['Relation Name'])).toEqual([]);
  if (entry.ordered) expect(nodes.map((node) => node['Node Type'])).not.toContain('Sort');
  return nodes;
}
