import { afterAll, describe, expect, test } from 'bun:test';
import { describeDb } from '../support/db';
import { closePostgresTarget } from './postgresTarget';
import { runModel, settingsFromEnv } from './run';
import { PLANTED_BUGS, TARGET_COMMANDS, TARGETS } from './targets';

const settings = settingsFromEnv();
const TIMEOUT_MS = 30 * 60_000;
/** Fixed so the gate is deterministic. Every planted bug is found well within these runs. */
const BUG_HUNT = { seed: 20_261_013, runs: 1_000, maxCommands: 60 } as const;

afterAll(closePostgresTarget);

describe('StateStore model harness', () => {
  test(
    `${settings.target}: every invariant holds (${settings.runs} runs, <= ${settings.maxCommands} commands)`,
    async () => {
      const result = await runModel(settings);
      // The report carries the seed, the minimised history and the replay command.
      if (result.failed) throw new Error(result.report);
      expect(result.failed).toBe(false);
    },
    TIMEOUT_MS
  );

  for (const target of Object.keys(PLANTED_BUGS) as Array<keyof typeof PLANTED_BUGS>) {
    const check = PLANTED_BUGS[target];
    test(`planted bug ${target} fails ${check} with a minimised, replayable history`, async () => {
      const found = await runModel({ ...BUG_HUNT, target, factory: TARGETS[target] });
      expect(found.failed).toBe(true);
      expect(found.check).toBe(check);
      expect(found.history.length).toBeGreaterThan(0);
      expect(found.history.length).toBeLessThanOrEqual(8);
      expect(found.report).toContain(`QCLOUD_MODEL_SEED=${found.seed} `);
      expect(found.report).toContain('bun run test:model');

      const replayed = await runModel({
        ...BUG_HUNT,
        target,
        factory: TARGETS[target],
        seed: found.seed,
        ...(found.path ? { path: found.path } : {}),
        ...(found.replayPath ? { replayPath: found.replayPath } : {}),
      });
      expect(replayed.failed).toBe(true);
      expect(replayed.check).toBe(check);
      expect(replayed.history).toEqual(found.history);
    });
  }
});

/**
 * The real store, on the commands it implements so far, with a fixed seed so the gate is
 * deterministic. Skipped without Postgres; `QCLOUD_MODEL_TARGET=postgres` (or `postgres-workers`, which
 * puts real `Worker`s on the claims and the ends of leases) runs it with the environment's runs and seed
 * instead.
 */
describeDb('StateStore model harness: postgres', () => {
  test(
    'every invariant holds on the commands the Postgres store implements',
    async () => {
      const result = await runModel({
        target: 'postgres',
        factory: TARGETS.postgres,
        commands: TARGET_COMMANDS.postgres!,
        seed: 20_261_014,
        runs: 100,
        maxCommands: 60,
      });
      if (result.failed) throw new Error(result.report);
      expect(result.failed).toBe(false);
    },
    TIMEOUT_MS
  );

  test(
    'every invariant holds with real Workers taking the bells and ending the leases',
    async () => {
      const result = await runModel({
        target: 'postgres-workers',
        factory: TARGETS['postgres-workers'],
        commands: TARGET_COMMANDS['postgres-workers']!,
        workers: true,
        seed: 20_261_019,
        runs: 100,
        maxCommands: 60,
      });
      if (result.failed) throw new Error(result.report);
      expect(result.failed).toBe(false);
    },
    TIMEOUT_MS
  );
});
