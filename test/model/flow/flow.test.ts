import { afterAll, expect, test } from 'bun:test';
import { describeDb } from '../../support/db';
import { PLANTED_FLOW_BUGS } from './planted';
import { COVERAGE, RULES } from './reference';
import { DEFAULT_RUNS, flowSettingsFromEnv, runFlowModel } from './run';
import { closeFlowTarget } from './world';

const TIMEOUT_MS = 30 * 60_000;
/** Fixed so the gate is deterministic. Every planted bug is found well within these runs. */
const BUG_HUNT = { seed: 20_261_050, runs: 1_000, maxCommands: 60 } as const;

afterAll(closeFlowTarget);

describeDb('flow model harness', () => {
  test(
    'every flow invariant holds against the model, in random histories',
    async () => {
      const settings = flowSettingsFromEnv();
      COVERAGE.clear();
      const result = await runFlowModel({ seed: 20_261_049, ...settings });
      // The report carries the seed, the minimised history and the replay command.
      if (result.failed) throw new Error(result.report);
      expect(result.failed).toBe(false);
      // A run too short to reach every rule proves nothing about the ones it missed.
      if (settings.runs >= DEFAULT_RUNS && !settings.path && !settings.replayPath) {
        const missed = RULES.filter((rule) => !COVERAGE.get(rule));
        // QCLOUD_FLOW_COVERAGE=1 prints how often each rule was reached, to tune the generator.
        if (process.env.QCLOUD_FLOW_COVERAGE) {
          for (const rule of RULES)
            console.log(`${String(COVERAGE.get(rule) ?? 0).padStart(5)}  ${rule}`);
        }
        expect(missed).toEqual([]);
      }
    },
    TIMEOUT_MS
  );

  for (const [name, { check, bug }] of Object.entries(PLANTED_FLOW_BUGS)) {
    test(
      `planted bug ${name} fails ${check} with a minimised, replayable history`,
      async () => {
        const found = await runFlowModel({ ...BUG_HUNT, planted: bug });
        expect(found.failed).toBe(true);
        expect(found.check).toBe(check);
        expect(found.history.length).toBeGreaterThan(0);
        expect(found.history.length).toBeLessThanOrEqual(8);
        expect(found.report).toContain(`QCLOUD_FLOW_MODEL_SEED=${found.seed} `);

        const replayed = await runFlowModel({
          ...BUG_HUNT,
          planted: bug,
          seed: found.seed,
          ...(found.path ? { path: found.path } : {}),
          ...(found.replayPath ? { replayPath: found.replayPath } : {}),
        });
        expect(replayed.failed).toBe(true);
        expect(replayed.check).toBe(check);
        expect(replayed.history).toEqual(found.history);
      },
      TIMEOUT_MS
    );
  }
});
