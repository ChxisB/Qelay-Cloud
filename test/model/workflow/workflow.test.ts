import { afterAll, expect, test } from 'bun:test';
import { describeDb } from '../../support/db';
import { PLANTED_WORKFLOW_BUGS } from './planted';
import { DEFAULT_RUNS, runWorkflowModel, workflowSettingsFromEnv } from './run';
import { COVERAGE, closeWorkflowTarget } from './world';

const TIMEOUT_MS = 30 * 60_000;
/** Fixed so the gate is deterministic. Every planted bug is found well within these runs. */
const BUG_HUNT = { seed: 20_261_060, runs: 1_000, maxCommands: 60 } as const;

/** Rules a standard run must reach: a run too short to reach one proves nothing about it. */
const RULES = [
  'save.created',
  'save.exists',
  'update.ok',
  'update.stale',
  'update.missing',
  'signal.resumed',
  'signal.recorded',
  'signal.duplicate',
  'signal.refused',
  'signal.unknown',
  'park.parked',
  'park.signalPresent',
  'park.refused',
  'park.badDeadline',
  'expire.expired',
  'expire.signalled',
  'expire.moved',
  'restore.true',
  'restore.false',
  'claim.some',
  'claim.none',
  'cleanup.some',
  'archive.some',
  'recoverable.some',
  'child.found',
] as const;

afterAll(closeWorkflowTarget);

describeDb('workflow store model harness', () => {
  test(
    'the Postgres store and the reference agree in random histories',
    async () => {
      const settings = workflowSettingsFromEnv();
      COVERAGE.clear();
      const result = await runWorkflowModel({ seed: 20_261_059, ...settings });
      // The report carries the seed, the minimised history and the replay command.
      if (result.failed) throw new Error(result.report);
      expect(result.failed).toBe(false);
      if (settings.runs >= DEFAULT_RUNS && !settings.path && !settings.replayPath) {
        // QCLOUD_WORKFLOW_COVERAGE=1 prints how often each rule was reached, to tune the generator.
        if (process.env.QCLOUD_WORKFLOW_COVERAGE) {
          for (const rule of RULES)
            console.log(`${String(COVERAGE.get(rule) ?? 0).padStart(5)}  ${rule}`);
        }
        expect(RULES.filter((rule) => !COVERAGE.get(rule))).toEqual([]);
      }
    },
    TIMEOUT_MS
  );

  for (const [name, { check, bug }] of Object.entries(PLANTED_WORKFLOW_BUGS)) {
    test(
      `planted bug ${name} fails ${check} with a minimised, replayable history`,
      async () => {
        const found = await runWorkflowModel({ ...BUG_HUNT, planted: bug });
        expect(found.failed).toBe(true);
        expect(found.check).toBe(check);
        expect(found.history.length).toBeGreaterThan(0);
        expect(found.history.length).toBeLessThanOrEqual(8);
        expect(found.report).toContain(`QCLOUD_WORKFLOW_MODEL_SEED=${found.seed} `);

        const replayed = await runWorkflowModel({
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
