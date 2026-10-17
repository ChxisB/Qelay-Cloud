/**
 * Version 10 DDL: the workflow definitions workers announce. One row per (workflow name, definition
 * hash): the step graph with its settings (as JSON text, written and read by the store, never a
 * handler), the explicit `revision`, when the hash was first announced, and when a worker last said
 * it still serves it. The Control API reads it to draw a run's graph and to warn when a live run is
 * bound to a hash that no worker serves any more.
 *
 * One new table and nothing else, so a release that does not know it carries on untouched: it never
 * announces anything, and the API then shows the graph as unknown.
 *
 * The primary key serves every read (a name's rows are a key range). The table holds a handful of
 * rows per workflow: a new hash also forgets that name's old ones (see `recordDefinition`).
 */
export const WORKFLOW_DEFINITION_STATEMENTS: readonly string[] = [
  `CREATE TABLE qcloud_workflow_definitions (
  namespace TEXT NOT NULL,
  name TEXT NOT NULL,
  hash TEXT NOT NULL,
  revision TEXT NOT NULL,
  graph TEXT NOT NULL,
  first_seen_at BIGINT NOT NULL,
  last_seen_at BIGINT NOT NULL,
  PRIMARY KEY (namespace, name, hash)
)`,
];
