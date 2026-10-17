import fc from 'fast-check';
import type { CommandName } from './command';
import { COMMAND_NAMES } from './command';
import { commandArbitraries } from './commands';
import type { StoreFactory } from './store';
import { isTargetName, TARGET_COMMANDS, TARGETS, WORKER_TARGETS } from './targets';
import { VirtualClock } from './transport';
import { WorkerBridge } from './workers';
import type { CheckName } from './world';
import {
  ALL_CHECKS,
  InvariantViolation,
  LOCK_TTL_MS,
  NAMESPACE,
  TICK_INTERVAL_MS,
  World,
} from './world';

/**
 * Every command the fake stores run. Not `recover` (a store with its own `recoverExpired`), nor the
 * cron commands and concurrent ticks: those need the Postgres store, which names them in its own set.
 */
const POSTGRES_ONLY: readonly CommandName[] = ['recover', 'upsertCron', 'concurrentTicks'];
const STORE_COMMANDS = COMMAND_NAMES.filter((name) => !POSTGRES_ONLY.includes(name));

/** Small enough for the gate. Deep runs raise them through the environment. */
export const DEFAULT_RUNS = 100;
export const DEFAULT_COMMANDS = 60;

export interface ModelSettings {
  readonly target: string;
  readonly runs: number;
  readonly maxCommands: number;
  readonly seed?: number;
  /** fast-check counterexample path: replays one case instead of generating runs. */
  readonly path?: string;
  /** fast-check command replay path, for the exact minimised history. */
  readonly replayPath?: string;
}

export interface ModelRunConfig extends ModelSettings {
  readonly factory: StoreFactory;
  /** Commands to generate. All by default; a store that is not finished enables a subset. */
  readonly commands?: readonly CommandName[];
  /** Checks that fail the run. All by default. */
  readonly checks?: readonly CheckName[];
  /** Real `Worker`s take the bells and end the leases (a Postgres store only). Default false. */
  readonly workers?: boolean;
}

export interface ModelRunResult {
  readonly failed: boolean;
  readonly seed: number;
  readonly check: CheckName | null;
  readonly history: readonly string[];
  readonly path: string | null;
  readonly replayPath: string | null;
  readonly report: string;
}

type Env = Readonly<Record<string, string | undefined>>;

/**
 * Settings from QCLOUD_MODEL_TARGET, _RUNS, _COMMANDS, _SEED, _PATH and _REPLAY_PATH. The target
 * defaults to the fake store; a planted-bug target must fail.
 */
export function settingsFromEnv(env: Env = process.env): ModelSettings & {
  factory: StoreFactory;
  commands?: readonly CommandName[];
  workers?: boolean;
} {
  const target = env.QCLOUD_MODEL_TARGET?.trim() || 'fake';
  if (!isTargetName(target)) {
    throw new Error(`QCLOUD_MODEL_TARGET must be one of ${Object.keys(TARGETS).join(', ')}`);
  }
  const seed = integer(env, 'QCLOUD_MODEL_SEED', Number.MIN_SAFE_INTEGER);
  const path = env.QCLOUD_MODEL_PATH?.trim();
  const replayPath = env.QCLOUD_MODEL_REPLAY_PATH?.trim();
  const commands = TARGET_COMMANDS[target];
  return {
    target,
    factory: TARGETS[target],
    ...(commands ? { commands } : {}),
    ...(WORKER_TARGETS.has(target) ? { workers: true } : {}),
    runs: integer(env, 'QCLOUD_MODEL_RUNS', 1) ?? DEFAULT_RUNS,
    maxCommands: integer(env, 'QCLOUD_MODEL_COMMANDS', 1) ?? DEFAULT_COMMANDS,
    ...(seed === undefined ? {} : { seed }),
    ...(path ? { path } : {}),
    ...(replayPath ? { replayPath } : {}),
  };
}

function integer(env: Env, name: string, min: number): number | undefined {
  const raw = env[name]?.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min) {
    throw new Error(`${name} must be an integer >= ${min}, got "${raw}"`);
  }
  return value;
}

export async function runModel(config: ModelRunConfig): Promise<ModelRunResult> {
  const checks = new Set(config.checks ?? ALL_CHECKS);
  const histories = fc.commands(commandArbitraries(new Set(config.commands ?? STORE_COMMANDS)), {
    maxCommands: config.maxCommands,
    // Lengths spread up to maxCommands; the default size keeps histories near 5 commands.
    size: 'max',
    ...(config.replayPath ? { replayPath: config.replayPath } : {}),
  });
  const property = fc.asyncProperty(histories, async (commands) => {
    const clock = new VirtualClock();
    const store = await config.factory({
      clock,
      namespace: NAMESPACE,
      lockTtlMs: LOCK_TTL_MS,
      reRingAfterMs: TICK_INTERVAL_MS,
    });
    const world = new World(store, clock, checks);
    if (config.workers) world.bridge = new WorkerBridge(world);
    try {
      await fc.asyncModelRun(() => ({ model: world.model, real: world }), commands);
    } finally {
      await world.bridge?.close();
      await store.close();
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
      report: `${config.target}: ${details.numRuns} runs passed (seed ${details.seed})`,
    };
  }
  return failure(config, details);
}

type FailedRun = Pick<
  fc.RunDetails<[unknown]>,
  'counterexample' | 'counterexamplePath' | 'errorInstance' | 'numRuns' | 'numShrinks' | 'seed'
>;

function failure(config: ModelRunConfig, details: FailedRun): ModelRunResult {
  const error = details.errorInstance;
  const check = error instanceof InvariantViolation ? error.check : null;
  const commands = (details.counterexample?.[0] ?? []) as Iterable<{ hasRan?: boolean }>;
  const history = [...commands].filter((command) => command.hasRan !== false).map(String);
  const replayPath = /replayPath="([^"]*)"/.exec(String(commands))?.[1] ?? null;
  const path = details.counterexamplePath;
  const settings = [
    `QCLOUD_MODEL_SEED=${details.seed}`,
    config.target === 'fake' ? '' : `QCLOUD_MODEL_TARGET=${config.target}`,
    config.runs === DEFAULT_RUNS ? '' : `QCLOUD_MODEL_RUNS=${config.runs}`,
    config.maxCommands === DEFAULT_COMMANDS ? '' : `QCLOUD_MODEL_COMMANDS=${config.maxCommands}`,
  ].filter(Boolean);
  const exact = [
    ...settings,
    path ? `QCLOUD_MODEL_PATH="${path}"` : '',
    replayPath ? `QCLOUD_MODEL_REPLAY_PATH="${replayPath}"` : '',
  ].filter(Boolean);
  const message = error instanceof Error ? error.message : String(error);
  const report = [
    `Model run failed against "${config.target}" after ${details.numRuns} runs ` +
      `(seed ${details.seed}, shrunk ${details.numShrinks} times).`,
    '',
    message,
    '',
    `Minimised history (${history.length} commands):`,
    ...history.map((line, index) => `  ${String(index + 1).padStart(3)}. ${line}`),
    '',
    'Replay (re-runs and shrinks to the same history):',
    `  ${settings.join(' ')} bun run test:model`,
    'Replay only the minimised history:',
    `  ${exact.join(' ')} bun run test:model`,
  ].join('\n');
  return { failed: true, seed: details.seed, check, history, path, replayPath, report };
}
