/**
 * Version 6 DDL: what a flow child does to its parent when it fails for good. `on_failure` sits on
 * the dependency edge, because the terminal hook (`store/flowTerminal.ts`) reads the edge and must
 * not depend on the child's row, which `removeOnFail` has already deleted by then. Null means the
 * child sets no policy and the parent keeps waiting on it. A nullable column with a check, so
 * releases that do not know it carry on: they never write an edge.
 */
export const FLOW_STATEMENTS: readonly string[] = [
  `ALTER TABLE qcloud_dependencies
  ADD COLUMN on_failure TEXT CHECK (on_failure IN ('fail', 'continue', 'ignore', 'remove'))`,
];

/**
 * Version 7 DDL: which flow a job belongs to. `flow_root` is the id of the flow's root job (the root
 * names itself) and `flow_depth` how far the job is below it (the root is 0); both are null for a job
 * that is in no flow. They let the control API read one flow, or list the flows, with a bounded index
 * scan instead of a walk up and down `parent_id`. Only `addFlow` writes them, and no earlier release
 * writes flows, so old workers never meet a flow row they cannot read. Nullable columns, so a release
 * that does not know them carries on.
 */
export const FLOW_ROOT_STATEMENTS: readonly string[] = [
  `ALTER TABLE qcloud_jobs
  ADD COLUMN flow_root TEXT,
  ADD COLUMN flow_depth INTEGER CHECK (flow_depth >= 0),
  ADD CONSTRAINT qcloud_jobs_flow_columns CHECK ((flow_root IS NULL) = (flow_depth IS NULL))`,
  // One flow, top level first, so a capped read returns whole levels from the root down.
  `CREATE INDEX qcloud_jobs_flow_idx
  ON qcloud_jobs(namespace, flow_root, flow_depth, id)
  WHERE flow_root IS NOT NULL`,
  // The flows of the namespace, newest first: one entry per root.
  `CREATE INDEX qcloud_jobs_flow_roots_idx
  ON qcloud_jobs(namespace, created_at DESC, id DESC)
  WHERE flow_depth = 0`,
];
