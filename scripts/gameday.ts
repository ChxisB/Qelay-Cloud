/**
 * The local game day (task 71): each drill breaks one thing the runbooks cover, reads the signal the
 * runbook names and applies the runbook's fix, on Postgres and the two broker emulators.
 *
 *   bun run test:gameday -- --local
 *
 * `--local` is required: no game day against a real cloud exists, and none is run without the owner's
 * go-ahead (D9). The databases and emulators it needs must be up; one that is down fails the run.
 */
const fail = (message: string): never => {
  console.error(message);
  process.exit(2);
};

if (!process.argv.includes('--local')) fail('usage: gameday.ts --local (a real-cloud game day does not exist)');
if (process.env.QCLOUD_REAL_CLOUD === '1') fail('QCLOUD_REAL_CLOUD is set, but this game day only ever talks to local services.');

const run = Bun.spawn(['bun', 'test', 'test/gameday'], {
  env: { ...process.env, QCLOUD_REQUIRE_DB: '1', QCLOUD_REQUIRE_PUBSUB: '1', QCLOUD_REQUIRE_SQS: '1' },
  stdio: ['inherit', 'inherit', 'inherit'],
});
const code = await run.exited;
console.log(
  '\nWhat this was: local Postgres and the Pub/Sub and SQS emulators, with thresholds shrunk to seconds and the signals read through the\n' +
    "Control API in process. It shows each runbook's signal appears and its fix clears it. It does not show that a cloud alert fires,\n" +
    'that an OpenTelemetry export reaches a collector, or that a provider command (a point-in-time clone, a seek, a purge) works.'
);
process.exit(code);
