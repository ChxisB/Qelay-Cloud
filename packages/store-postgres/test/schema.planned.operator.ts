import { AUDIT_LIST, AUDIT_PRUNE_AGE, AUDIT_PRUNE_COUNT } from '../src/store/audit';
import { PROTECTED_BY_OUTSIDE_CONSUMER } from '../src/store/flowGuard';
import { JOB_DETAILS, JOBS_DETAILS } from '../src/store/jobDetails';
import { JOB_FAILURE, JOBS_FAILURE } from '../src/store/jobFailure';
import { pendingCandidates } from '../src/store/pendingClean';
import { ACTIVE_JOB, QUEUE_JOBS, QUEUE_ROWS } from '../src/store/queueControl';
import type { Planned } from './schema.planned';

const PENDING = ['ns', 'q', 5000, Number.MAX_SAFE_INTEGER, 1001];

/** The query paths of the operator's work (task 18): draining and cleaning, the flow guard, one job in full, obliterating a queue. */
export const PLANNED_OPERATOR: readonly Planned[] = [
  {
    query: 'drain: every pending job of a queue, in claim order, locking what it takes',
    sql: pendingCandidates(null),
    params: PENDING,
    index: 'qcloud_jobs_ready_idx',
    ordered: true,
  },
  {
    query: 'clean: waiting jobs created long enough ago',
    sql: pendingCandidates('waiting'),
    params: PENDING,
    index: 'qcloud_jobs_ready_idx',
    ordered: true,
  },
  {
    query: 'clean: prioritized jobs created long enough ago',
    sql: pendingCandidates('prioritized'),
    params: PENDING,
    index: 'qcloud_jobs_ready_idx',
    ordered: true,
  },
  {
    query: 'clean: delayed jobs created long enough ago',
    sql: pendingCandidates('delayed'),
    params: PENDING,
    index: 'qcloud_jobs_delayed_idx',
    ordered: true,
  },
  {
    query: 'flow guard: which of some jobs a live consumer depends on',
    sql: `SELECT DISTINCT dependency.dependency_id FROM qcloud_dependencies AS dependency
          JOIN qcloud_jobs AS consumer ON consumer.namespace = dependency.namespace AND consumer.id = dependency.job_id
          WHERE dependency.namespace = 'ns' AND dependency.dependency_id = ANY(ARRAY['j1', 'j2'])
          AND consumer.state IN ('waiting', 'prioritized', 'delayed', 'waiting-children', 'active')`,
    index: 'qcloud_dependencies_dependency_idx',
  },
  {
    query: 'flow guard: a job of a queue that a live consumer in another queue depends on',
    sql: PROTECTED_BY_OUTSIDE_CONSUMER,
    params: ['ns', 'q'],
    index: 'qcloud_jobs_pkey',
    // The seed has 400 flow edges and 8,000 jobs in the queue: the edges drive the statement.
    avoid: ['qcloud_jobs_state_idx'],
  },
  {
    // The selection of `retryDlqMany` (and the shape of the purge and the listing of the DLQ): the failed rows of one queue
    // come from the state index and are sorted by failure time, a cost that follows the size of the DLQ, which an operator
    // call reads whole anyway. The unfiltered plan is the one tested; `reason` and the flow and dedup checks only narrow it.
    query: 'dlq retry: the oldest failed jobs of a queue, locking what it takes',
    sql: `SELECT job.id FROM qcloud_jobs AS job
          WHERE job.namespace = 'ns' AND job.queue = 'q' AND job.state = 'failed'
          ORDER BY job.completed_at ASC NULLS FIRST, job.id ASC LIMIT 500
          FOR UPDATE OF job SKIP LOCKED`,
    index: 'qcloud_jobs_state_idx',
  },
  {
    query: 'job details: one job by id',
    sql: JOB_DETAILS,
    params: ['ns', 'j1'],
    index: 'qcloud_jobs_pkey',
  },
  {
    query: 'job failure: the final reason and the attempt history of one job',
    sql: JOB_FAILURE,
    params: ['ns', 'j1'],
    index: 'qcloud_jobs_pkey',
  },
  {
    query: 'job failure: the failures of a page of jobs by id',
    sql: JOBS_FAILURE,
    params: ['ns', '{j1,j2,j3}'],
    index: 'qcloud_jobs_pkey',
  },
  {
    query: 'audit: the newest entries of the namespace',
    sql: AUDIT_LIST,
    params: ['ns', null, null, null, null, 51],
    index: 'qcloud_audit_namespace_id_idx',
    ordered: true,
  },
  {
    query: 'audit: the next page of one subject, from a cursor',
    sql: AUDIT_LIST,
    params: ['ns', 5000, 'alice', null, 'rejected', 51],
    index: 'qcloud_audit_namespace_id_idx',
    ordered: true,
  },
  {
    query: 'audit retention: the oldest entries past the age cut',
    sql: AUDIT_PRUNE_AGE,
    params: ['ns', 1000, 1000],
    index: 'qcloud_audit_namespace_time_idx',
    ordered: true,
  },
  {
    query: 'audit retention: the oldest entries past the count cap',
    sql: AUDIT_PRUNE_COUNT,
    params: ['ns', 100000, 1000],
    index: 'qcloud_audit_namespace_id_idx',
    ordered: true,
  },
  {
    query: 'job details: a page of jobs by id',
    sql: JOBS_DETAILS,
    params: ['ns', '{j1,j2,j3}'],
    index: 'qcloud_jobs_pkey',
  },
  {
    query: 'obliterate: a batch of the jobs of a queue, locking them',
    sql: QUEUE_JOBS,
    params: ['ns', 'q', 1001],
    index: 'qcloud_jobs_state_idx',
    ordered: true,
  },
  {
    query: 'obliterate: an active job of the queue',
    sql: ACTIVE_JOB,
    params: ['ns', 'q'],
    index: 'qcloud_jobs_state_idx',
    ordered: true,
  },
  {
    query: 'obliterate: the repeat links of a batch',
    sql: `DELETE FROM qcloud_repeat_links WHERE namespace = 'ns'
          AND (original_id = ANY(ARRAY['j1']) OR successor_id = ANY(ARRAY['j1']))`,
    index: 'qcloud_repeat_links_successor_idx',
  },
  ...QUEUE_ROWS.map(([table, index]) => ({
    query: `obliterate: the ${table} rows of a queue`,
    sql: `DELETE FROM ${table} WHERE namespace = $1 AND queue = $2`,
    params: ['ns', 'q'],
    index,
  })),
];
