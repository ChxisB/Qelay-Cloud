/**
 * The transports the contract suite and the scenarios run against, by the names the `test:contract` and
 * `test:scenarios` scripts and CI take. A name is a deployment, not a package: `local` is two stacks.
 *
 * Emulator names run anywhere the emulator does. `gcp` and `aws` mean the real cloud: they are refused
 * unless `QCLOUD_REAL_CLOUD=1` and the person running them has said the resources may be used (D9).
 */
export type StackName = 'memory' | 'postgres' | 'pubsub' | 'sqs';

export interface TransportSelector {
  /** The scenario stacks this name runs. */
  readonly stacks: readonly StackName[];
  /** The contract harness files this name runs. */
  readonly contract: readonly string[];
  /** Variables that make an unreachable emulator fail the run instead of skipping it. */
  readonly require: Readonly<Record<string, string>>;
  /** True for a real cloud: paid, shared, needs the user's go-ahead. */
  readonly real: boolean;
}

export const TRANSPORT_SELECTORS = {
  local: {
    stacks: ['memory', 'postgres'],
    contract: ['test/contract/memory.test.ts', 'test/contract/postgres.test.ts'],
    require: {},
    real: false,
  },
  'gcp-emulator': {
    stacks: ['pubsub'],
    contract: ['test/contract/pubsub.test.ts'],
    require: { QCLOUD_REQUIRE_PUBSUB: '1' },
    real: false,
  },
  'aws-emulator': {
    stacks: ['sqs'],
    contract: ['test/contract/sqs.test.ts'],
    require: { QCLOUD_REQUIRE_SQS: '1' },
    real: false,
  },
  gcp: { stacks: [], contract: [], require: {}, real: true },
  aws: { stacks: [], contract: [], require: {}, real: true },
} as const satisfies Record<string, TransportSelector>;

export type TransportName = keyof typeof TRANSPORT_SELECTORS;

export const TRANSPORT_NAMES = Object.keys(TRANSPORT_SELECTORS) as TransportName[];

export function isTransportName(value: string): value is TransportName {
  return value in TRANSPORT_SELECTORS;
}

/** The stacks the scenario suite runs: `QCLOUD_SCENARIO_TRANSPORTS` (names, comma separated) or every emulator one. */
export function selectedStacks(raw = process.env.QCLOUD_SCENARIO_TRANSPORTS): StackName[] {
  if (raw === undefined || raw.trim() === '') return ['memory', 'postgres', 'pubsub', 'sqs'];
  const stacks = new Set<StackName>();
  for (const name of raw.split(',').map((part) => part.trim())) {
    if (!isTransportName(name)) throw new Error(`Unknown transport "${name}"`);
    for (const stack of TRANSPORT_SELECTORS[name].stacks) stacks.add(stack);
  }
  return [...stacks];
}
