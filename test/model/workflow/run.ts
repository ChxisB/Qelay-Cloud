import type { Arbitrary } from 'fast-check';
import fc from 'fast-check';
import { COMMANDS } from './commands';
import type { WorkflowCheck } from './world';
import { WorkflowViolation, WorkflowWorld } from './world';
import type { Planted } from './world';

/** Small enough for the gate. A deep run raises them through QCLOUD_MODEL_RUNS and _COMMANDS. */
export const DEFAULT_RUNS = 200;
export const DEFAULT_COMMANDS = 60;

export interface WorkflowRunConfig {
  readonly runs: number;
  readonly maxCommands: number;
  readonly seed?: number;
  /** fast-check counterexample path: replays one case instead of generating runs. */
  readonly path?: string;
  /** fast-check command replay path, for the exact minimised history. */
  readonly replayPath?: string;
  /** A bug planted in the store's data, which the run must find. */
  readonly planted?: Planted;
}

export interface WorkflowRunResult {
  readonly failed: boolean;
  readonly seed: number;
  readonly check: WorkflowCheck | null;
  readonly history: readonly string[];
  readonly path: string | null;
  readonly replayPath: string | null;
  readonly report: string;
}

type Env = Readonly<Record<string, string | undefined>>;

function integer(env: Env, name: string, min: number): number | undefined {
  const raw = env[name]?.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min) {
    throw new Error(`${name} must be an integer >= ${min}, got "${raw}"`);
  }
  return value;
}

/**
 * Settings from QCLOUD_MODEL_RUNS and _COMMANDS, which deepen every model run, and
 * QCLOUD_WORKFLOW_MODEL_SEED, _PATH and _REPLAY_PATH, which replay one failure of this harness and no other.
 */
export function workflowSettingsFromEnv(env: Env = process.env): WorkflowRunConfig {
  const seed = integer(env, 'QCLOUD_WORKFLOW_MODEL_SEED', Number.MIN_SAFE_INTEGER);
  const path = env.QCLOUD_WORKFLOW_MODEL_PATH?.trim();
  const replayPath = env.QCLOUD_WORKFLOW_MODEL_REPLAY_PATH?.trim();
  return {
    runs: integer(env, 'QCLOUD_MODEL_RUNS', 1) ?? DEFAULT_RUNS,
    maxCommands: integer(env, 'QCLOUD_MODEL_COMMANDS', 1) ?? DEFAULT_COMMANDS,
    ...(seed === undefined ? {} : { seed }),
    ...(path ? { path } : {}),
    ...(replayPath ? { replayPath } : {}),
  };
}

export async function runWorkflowModel(config: WorkflowRunConfig): Promise<WorkflowRunResult> {
  const histories = fc.commands(
    COMMANDS as Array<Arbitrary<fc.AsyncCommand<object, WorkflowWorld>>>,
    {
      maxCommands: config.maxCommands,
      size: 'max',
      ...(config.replayPath ? { replayPath: config.replayPath } : {}),
    }
  );
  const property = fc.asyncProperty(histories, async (commands) => {
    const world = await WorkflowWorld.open(config.planted ?? null);
    try {
      await fc.asyncModelRun(() => ({ model: {}, real: world }), commands);
    } finally {
      await world.close();
    }
  });
  // No `endOnFailure`: it would skip shrinking, and the report must show a minimised history.
  const details = await fc.check(property, {
    numRuns: config.runs,
    ...(config.seed === undefined ? {} : { seed: config.seed }),
    ...(config.path ? { path: config.path } : {}),
  });
  if (!details.failed) {
    return {
      failed: false,
      seed: details.seed,
      check: null,
      history: [],
      path: null,
      replayPath: null,
      report: `workflows: ${details.numRuns} runs passed (seed ${details.seed})`,
    };
  }
  const error = details.errorInstance;
  const commands = (details.counterexample?.[0] ?? []) as Iterable<{ hasRan?: boolean }>;
  const history = [...commands].filter((command) => command.hasRan !== false).map(String);
  const replayPath = /replayPath="([^"]*)"/.exec(String(commands))?.[1] ?? null;
  const path = details.counterexamplePath;
  const settings = [
    `QCLOUD_WORKFLOW_MODEL_SEED=${details.seed}`,
    config.runs === DEFAULT_RUNS ? '' : `QCLOUD_MODEL_RUNS=${config.runs}`,
    config.maxCommands === DEFAULT_COMMANDS ? '' : `QCLOUD_MODEL_COMMANDS=${config.maxCommands}`,
  ].filter(Boolean);
  const exact = [
    ...settings,
    path ? `QCLOUD_WORKFLOW_MODEL_PATH="${path}"` : '',
    replayPath ? `QCLOUD_WORKFLOW_MODEL_REPLAY_PATH="${replayPath}"` : '',
  ].filter(Boolean);
  const report = [
    `Workflow model run failed after ${details.numRuns} runs (seed ${details.seed}, shrunk ${details.numShrinks} times).`,
    '',
    error instanceof Error ? error.message : String(error),
    '',
    `Minimised history (${history.length} commands):`,
    ...history.map((line, index) => `  ${String(index + 1).padStart(3)}. ${line}`),
    '',
    'Replay (re-runs and shrinks to the same history):',
    `  ${settings.join(' ')} bun test test/model/workflow`,
    'Replay only the minimised history:',
    `  ${exact.join(' ')} bun test test/model/workflow`,
  ].join('\n');
  return {
    failed: true,
    seed: details.seed,
    check: error instanceof WorkflowViolation ? error.check : null,
    history,
    path,
    replayPath,
    report,
  };
}
