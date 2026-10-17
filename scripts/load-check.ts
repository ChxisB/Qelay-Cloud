/**
 * Task 22's load and plan check: 100,000 jobs over 5 queues and 16 workers with the in-process tick off and
 * on, a 100,000-job backlog nobody rang (what the tick's per-queue ring cap does to it, and the plans of the
 * claim and ring queries on that table), and one hot queue with and without a rate limit (contention on its
 * row). Every drain ends in a reconciliation: the rows are exactly the jobs added, all completed, and no job
 * ran twice.
 *
 * The workers are `Worker`s in this one process: they share an event loop and a CPU with the producers, so
 * the numbers are a floor for a fleet of separate processes. The shape follows `../qelay/bench` (100-byte
 * payload, bulk of 100, concurrency 10) so the figures can be set beside Qelay's.
 *
 *   QCLOUD_TEST_DATABASE_URL=... bun run scripts/load-check.ts [jobs=100000] [workers=16] [only]
 *
 * `only` runs the drains whose label contains it (`tick every 5`, `hot queue`), and `backlog` the backlog.
 *
 * Needs Postgres; it creates schemas of its own and drops them.
 */
import { backlog } from './load-backlog';
import type { Run } from './load-drain';
import { drain } from './load-drain';
import { QUEUES } from './load-lib';

const jobs = Number(process.argv[2] ?? 100_000);
const workers = Number(process.argv[3] ?? 16);
const only = process.argv[4];
const wanted = (label: string): boolean => only === undefined || label.includes(only);
const hot = Math.min(jobs, 20_000);
const all = { queues: QUEUES, jobs, workers };

console.log(
  `load check: ${jobs} jobs, ${workers} workers x concurrency 10, ${new Date().toISOString()}`
);
const runs: Run[] = [
  { ...all, label: `${QUEUES.length} queues, no tick`, tickMs: null },
  {
    ...all,
    label: `${QUEUES.length} queues, in-process tick every 5 s (the default)`,
    tickMs: 5_000,
  },
  { ...all, label: `${QUEUES.length} queues, in-process tick every 1 s`, tickMs: 1_000 },
];
const one = { queues: ['q'], jobs: hot, workers, tickMs: null };
const hotRuns: Run[] = [
  { ...one, label: `one hot queue, ${hot} jobs, no rate limit` },
  {
    ...one,
    label: `one hot queue, ${hot} jobs, a rate limit that never binds (1,000,000 per second)`,
    rateLimit: 1_000_000,
  },
];

const results: boolean[] = [];
for (const run of runs.filter((r) => wanted(r.label))) results.push(await drain(run));
if (wanted('backlog')) await backlog(jobs);
for (const run of hotRuns.filter((r) => wanted(r.label))) results.push(await drain(run));
console.log(`\nreconciliations: ${results.filter(Boolean).length} of ${results.length} OK`);
if (results.includes(false)) process.exitCode = 1;
