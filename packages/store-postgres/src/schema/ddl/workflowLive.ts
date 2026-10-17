/**
 * Version 11 DDL: the index behind `liveDefinitions()`, which counts the runs that still hold their
 * definition in use per workflow and definition hash. The Control API asks it on every workflows
 * list, to warn when a live run is bound to a hash that no worker serves any more.
 *
 * One new partial index and nothing else, so a release that does not know it carries on untouched.
 * It holds only the rows in a live state, which are few next to the finished runs a table collects,
 * so the count reads the index alone and does not grow with the history.
 */
export const WORKFLOW_LIVE_STATEMENTS: readonly string[] = [
  `CREATE INDEX qcloud_workflow_executions_live_idx
  ON qcloud_workflow_executions(namespace, workflow_name, definition_hash)
  WHERE state IN ('running', 'waiting', 'compensating', 'compensation-stuck')`,
];
