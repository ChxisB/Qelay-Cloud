/**
 * Measures how late a delayed job is claimed when the in-process tick is the only thing that rings
 * it, for two intervals and for a zero and a real ring window. The numbers go in the Result of
 * task 20 and in docs/limits.md. Needs Postgres (`QCLOUD_TEST_DATABASE_URL`, default the compose
 * one); it creates a schema of its own and drops it.
 *
 *   QCLOUD_TEST_DATABASE_URL=... bun run scripts/measure-tick-lateness.ts [jobs=60]
 */
import { measureLateness } from '../packages/maintenance/test/lateness';
import { openTestStore } from '../packages/store-postgres/test/storeHelpers';

const jobs = Number(process.argv[2] ?? 60);
const t = await openTestStore({ clock: null, ringWindowMs: 0, poolSize: 8 });
console.log(
  'interval | window | n | mean | p50 | p95 | max | min | early bells | tick pass (mean ms)  (all ms)'
);
try {
  for (const intervalMs of [500, 2_000]) {
    // 0 rings a delayed job only once due; the other is the default floor, interval + 1,000 ms.
    for (const windowMs of [0, intervalMs + 1_000]) {
      const r = await measureLateness({
        t,
        intervalMs,
        windowMs,
        jobs,
        queue: `q-${intervalMs}-${windowMs}`,
      });
      console.log(
        [
          intervalMs,
          windowMs,
          r.n,
          r.mean.toFixed(0),
          r.p50,
          r.p95,
          r.max,
          r.min,
          r.earlyBells,
          r.tickMeanMs.toFixed(1),
        ].join(' | ')
      );
    }
  }
} finally {
  await t.drop();
}
