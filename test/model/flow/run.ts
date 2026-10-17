import fc from 'fast-check';
import type { Arbitrary } from 'fast-check';
import type { FlowCommand } from './command';
import { AddFlow, Claim, CompleteTogether, End, ReplayFlow, Zombie } from './commands';
import type { BellFate } from './commands';
import {
  AdvanceClock,
  Cancel,
  ChangePriority,
  Outage,
  Promote,
  Recover,
  Remove,
  Tick,
} from './operations';
import { FLOW_QUEUES, flowSpec } from './spec';
import type { FlowCheck, Planted } from './world';
import { FlowViolation, FlowWorld } from './world';

/** Small enough for the gate. A deep run raises them through QCLOUD_MODEL_RUNS and _COMMANDS. */
export const DEFAULT_RUNS = 200;
export const DEFAULT_COMMANDS = 60;

export interface FlowRunConfig {
  readonly runs: number;
  readonly maxCommands: number;
  readonly seed?: number;
  /** fast-check counterexample path: replays one case instead of generating runs. */
  readonly path?: string;
  /** fast-check command replay path, for the exact minimised history. */
  readonly replayPath?: string;
  /** A bug planted in the store's data, which the run must find. */
  readonly planted?: Planted;
  readonly label?: string;
}

export interface FlowRunResult {
  readonly failed: boolean;
  readonly seed: number;
  readonly check: FlowCheck | null;
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
 * Settings from QCLOUD_MODEL_RUNS and _COMMANDS, which deepen every model run, and QCLOUD_FLOW_MODEL_SEED,
 * _PATH and _REPLAY_PATH, which replay one failure of this harness and no other.
 */
export function flowSettingsFromEnv(env: Env = process.env): FlowRunConfig {
  const seed = integer(env, 'QCLOUD_FLOW_MODEL_SEED', Number.MIN_SAFE_INTEGER);
  const path = env.QCLOUD_FLOW_MODEL_PATH?.trim();
  const replayPath = env.QCLOUD_FLOW_MODEL_REPLAY_PATH?.trim();
  return {
    runs: integer(env, 'QCLOUD_MODEL_RUNS', 1) ?? DEFAULT_RUNS,
    maxCommands: integer(env, 'QCLOUD_MODEL_COMMANDS', 1) ?? DEFAULT_COMMANDS,
    ...(seed === undefined ? {} : { seed }),
    ...(path ? { path } : {}),
    ...(replayPath ? { replayPath } : {}),
  };
}

const pick = fc.nat(40);
const fate = fc.constantFrom<BellFate>('rung', 'rung', 'rung', 'dropped');
const worker = fc.constantFrom('w0', 'w1');
const queue = fc.constantFrom(...FLOW_QUEUES);
const make = <T extends FlowCommand>(build: () => T): Arbitrary<FlowCommand> =>
  fc.constant(null).map(build);

/** Commands that make progress come up more often than the operator's, which come up more than the odd ones. */
const COMMANDS: Array<Arbitrary<FlowCommand>> = [
  ...Array.from({ length: 3 }, () =>
    fc.tuple(flowSpec, fate).map(([spec, f]) => new AddFlow(spec, f))
  ),
  ...Array.from({ length: 4 }, () =>
    fc.tuple(queue, worker, fc.integer({ min: 1, max: 3 })).map(([q, w, n]) => new Claim(q, w, n))
  ),
  ...Array.from({ length: 4 }, () => pick.map((p) => new End('complete', p))),
  ...Array.from({ length: 3 }, () => pick.map((p) => new End('fail', p))),
  fc.tuple(pick, pick).map(([a, b]) => new CompleteTogether(a, b)),
  fc.constantFrom(1_000, 10_000, 29_999, 30_000, 31_000).map((ms) => new AdvanceClock(ms)),
  make(() => new Recover()),
  make(() => new Outage()),
  make(() => new Tick()),
  pick.map((p) => new ReplayFlow(p)),
  pick.map((p) => new Zombie(p)),
  pick.map((p) => new Cancel(p)),
  pick.map((p) => new Remove(p)),
  pick.map((p) => new Promote(p)),
  fc.tuple(pick, fc.nat(3)).map(([p, priority]) => new ChangePriority(p, priority)),
];

export async function runFlowModel(config: FlowRunConfig): Promise<FlowRunResult> {
  const histories = fc.commands(COMMANDS, {
    maxCommands: config.maxCommands,
    size: 'max',
    ...(config.replayPath ? { replayPath: config.replayPath } : {}),
  });
  const property = fc.asyncProperty(histories, async (commands) => {
    const world = await FlowWorld.open(config.planted ?? null);
    try {
      await fc.asyncModelRun(() => ({ model: world.model, real: world }), commands);
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
      report: `flows: ${details.numRuns} runs passed (seed ${details.seed})`,
    };
  }
  const error = details.errorInstance;
  const commands = (details.counterexample?.[0] ?? []) as Iterable<{ hasRan?: boolean }>;
  const history = [...commands].filter((command) => command.hasRan !== false).map(String);
  const replayPath = /replayPath="([^"]*)"/.exec(String(commands))?.[1] ?? null;
  const path = details.counterexamplePath;
  const settings = [
    `QCLOUD_FLOW_MODEL_SEED=${details.seed}`,
    config.runs === DEFAULT_RUNS ? '' : `QCLOUD_MODEL_RUNS=${config.runs}`,
    config.maxCommands === DEFAULT_COMMANDS ? '' : `QCLOUD_MODEL_COMMANDS=${config.maxCommands}`,
  ].filter(Boolean);
  const exact = [
    ...settings,
    path ? `QCLOUD_FLOW_MODEL_PATH="${path}"` : '',
    replayPath ? `QCLOUD_FLOW_MODEL_REPLAY_PATH="${replayPath}"` : '',
  ].filter(Boolean);
  const report = [
    `Flow model run failed after ${details.numRuns} runs (seed ${details.seed}, shrunk ${details.numShrinks} times).`,
    '',
    error instanceof Error ? error.message : String(error),
    '',
    `Minimised history (${history.length} commands):`,
    ...history.map((line, index) => `  ${String(index + 1).padStart(3)}. ${line}`),
    '',
    'Replay (re-runs and shrinks to the same history):',
    `  ${settings.join(' ')} bun test test/model/flow`,
    'Replay only the minimised history:',
    `  ${exact.join(' ')} bun test test/model/flow`,
  ].join('\n');
  return {
    failed: true,
    seed: details.seed,
    check: error instanceof FlowViolation ? error.check : null,
    history,
    path,
    replayPath,
    report,
  };
}
