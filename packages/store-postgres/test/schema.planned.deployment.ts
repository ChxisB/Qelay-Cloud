import { DOORBELL_HEALTH } from '../src/store/deployment';
import type { Planned } from './schema.planned';

/** namespace, queue, now, graceMs, reRingAfterMs, cap */
const HEALTH = ['ns', 'q', 5000, 2000, 5000, 1000];

/** The query paths of the Deployment page's reads (task 35). One statement, three index scans. */
export const PLANNED_DEPLOYMENT: readonly Planned[] = [
  {
    query: 'doorbell health: claimable jobs of a queue, counted up to a cap',
    sql: DOORBELL_HEALTH,
    params: HEALTH,
    index: 'qcloud_jobs_ready_idx',
  },
  {
    query: 'doorbell health: claimable jobs with no bell, and the oldest of them',
    sql: DOORBELL_HEALTH,
    params: HEALTH,
    index: 'qcloud_jobs_unrung_idx',
  },
  {
    query: 'doorbell health: claimable jobs whose last bell is older than the re-ring threshold',
    sql: DOORBELL_HEALTH,
    params: HEALTH,
    index: 'qcloud_jobs_ring_idx',
  },
  {
    query: 'doorbell health: which of a list of job ids exist',
    sql: `SELECT id FROM qcloud_jobs WHERE namespace = 'ns' AND id = ANY(ARRAY['j1', 'j2', 'j3']::text[])`,
    index: 'qcloud_jobs_pkey',
  },
];
