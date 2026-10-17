import type { FlowCheck, Planted } from './world';

/**
 * Bugs planted in what a store would return or hold, each one the harness must find with a minimised,
 * replayable history, and each by a different check. They are the flow bugs that matter: a parent let go
 * while a child is unfinished, a dependency row lost, a failure the parent was owed lost, and a bell
 * rung for a parent that waits.
 */
export const PLANTED_FLOW_BUGS: Readonly<Record<string, { check: FlowCheck; bug: Planted }>> = {
  'early-release': {
    check: 'F1.state',
    bug: {
      async afterAdd(world, ids) {
        await world.sql`
          UPDATE qcloud_jobs SET state = 'waiting'
          WHERE namespace = ${world.namespace} AND id = ${ids[0]!} AND state = 'waiting-children'`;
      },
    },
  },
  'lost-edge': {
    check: 'F2.edges',
    bug: {
      async afterAdd(world, ids) {
        await world.sql`
          DELETE FROM qcloud_dependencies
          WHERE namespace = ${world.namespace} AND job_id = ${ids[0]!}
            AND dependency_id = (SELECT min(dependency_id) FROM qcloud_dependencies
                                 WHERE namespace = ${world.namespace} AND job_id = ${ids[0]!})`;
      },
    },
  },
  'lost-failure': {
    check: 'F3.failures',
    bug: {
      async afterEnd(world) {
        await world.sql`DELETE FROM qcloud_flow_failures WHERE namespace = ${world.namespace}`;
      },
    },
  },
  'ringed-parent': {
    check: 'F7.rings',
    bug: {
      rings: (rings, ids) =>
        rings.length === 0
          ? rings
          : [...rings, { ...rings[0]!, bell: { ...rings[0]!.bell, jobId: ids[0]! } }],
    },
  },
};
