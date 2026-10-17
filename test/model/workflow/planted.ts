import type { Planted, WorkflowCheck } from './world';

/**
 * Bugs planted in what a store would hold, each one the harness must find with a minimised, replayable
 * history, and each by a different check: a delivered signal wiped, a version put back, a run copied to
 * the archive without leaving the live table, the archive emptied, and a wait whose deadline moved up so it is claimed early.
 * They are applied after a command, so the checks see them on the command that follows.
 */
export const PLANTED_WORKFLOW_BUGS: Readonly<
  Record<string, { check: WorkflowCheck; bug: Planted }>
> = {
  'lost-signal': {
    check: 'WF3.signals',
    bug: {
      async after(world, command) {
        if (command !== 'advance') return;
        await world.sql`
          UPDATE qcloud_workflow_executions SET signals = ${world.emptySignals}
          WHERE namespace = ${world.namespace}`;
      },
    },
  },
  'version-regress': {
    check: 'WF4.version',
    bug: {
      async after(world, command) {
        if (command !== 'advance') return;
        await world.sql`
          UPDATE qcloud_workflow_executions SET version = 0
          WHERE namespace = ${world.namespace} AND version > 0`;
      },
    },
  },
  'double-home': {
    check: 'WF1.state',
    bug: {
      async after(world, command) {
        if (command !== 'advance') return;
        await world.sql`
          INSERT INTO qcloud_workflow_executions_archive
            (namespace, id, workflow_name, state, input, steps, current_node_index, signals, version,
             created_at, updated_at, archived_at)
          SELECT namespace, id, workflow_name, state, input, steps, current_node_index, signals, version,
                 created_at, updated_at, updated_at
          FROM qcloud_workflow_executions WHERE namespace = ${world.namespace}
          ON CONFLICT DO NOTHING`;
      },
    },
  },
  'lost-archive': {
    check: 'WF5.archive',
    bug: {
      async after(world, command) {
        if (command !== 'advance') return;
        await world.sql`
          DELETE FROM qcloud_workflow_executions_archive WHERE namespace = ${world.namespace}`;
      },
    },
  },
  'early-wait': {
    check: 'WF2.outcome',
    bug: {
      async after(world, command) {
        if (command !== 'park') return;
        await world.sql`
          UPDATE qcloud_workflow_executions SET wait_deadline = 0
          WHERE namespace = ${world.namespace} AND state = 'waiting' AND wait_deadline IS NOT NULL`;
      },
    },
  },
};
