/**
 * Renders `docs/transports.md`. The capability table, the delay precision and the list of skipped
 * behaviours come from the code, so a change to a declaration or a skip changes the document, and
 * `test/contract/matrix.test.ts` fails until `bun run docs:transports` is run. The hand-written rows
 * are in `transportsDocMatrix.ts`.
 */
import type { DeliveryTransport } from '../packages/core/src';
import { SqsTransport } from '../packages/transport-aws/src';
import { ATTRIBUTES_LAG_MS, CLOUDWATCH_LAG_MS } from '../packages/transport-aws/src/monitoring';
import { MONITORING_LAG_MS, PubSubTransport } from '../packages/transport-gcp/src';
import { MemoryTransport, PostgresLocalTransport } from '../packages/transport-local/src';
import { CONTRACT_SKIPS } from '../test/contract/skips';
import { allScenarios } from '../test/scenarios/all';
import type { Column } from './transportsDocMatrix';
import { COLUMN_TITLES, COLUMNS, EMULATOR_ONLY, MATRIX } from './transportsDocMatrix';

export const BEGIN = (name: string) => `<!-- BEGIN generated:${name} -->`;
export const END = (name: string) => `<!-- END generated:${name} -->`;

/** The delay figures `docs/limits.md` section 1 holds. The generator prints them, a test finds each in both. */
export const DELAY_FIGURES: ReadonlyArray<readonly [mode: string, figure: string]> = [
  ['Pub/Sub, tick only on Cloud Scheduler', 'mean about 30 s, worst about 60 s'],
  ['Any window-0 transport, in-process tick, interval 500 ms', 'mean 270-292 ms, p95 479-513 ms'],
  ['The same, interval 2,000 ms', 'mean 1,080-1,113 ms, p95 1,950-1,956 ms'],
  ['A transport with a delivery window: the tick rings ahead', 'mean 6-8 ms after due'],
  ['Postgres: the poll interval', 'default 1,000 ms, jittered plus or minus 20 %'],
  ['SQS: rounding of `DelaySeconds`', 'rounded up to a whole second'],
];

export interface Instances {
  readonly declared: Record<Column, DeliveryTransport['capabilities']>;
}

/** Builds each transport without connecting, reads what it declares, and closes it. */
export async function declaredCapabilities(): Promise<Instances['declared']> {
  // None of these connects until it is used; the Postgres one is given a database that refuses.
  const refuse = () => {
    throw new Error('not connected');
  };
  const transports: Record<Column, DeliveryTransport> = {
    'gcp-pubsub': new PubSubTransport({ namespace: 'doc', projectId: 'doc' }),
    'aws-sqs': new SqsTransport({ namespace: 'doc', region: 'us-east-1', monitoring: false }),
    postgres: new PostgresLocalTransport({
      namespace: 'doc',
      db: { run: async () => refuse(), openListener: refuse },
      source: { hasClaimable: async () => false, snapshot: async () => refuse() },
    }),
    memory: new MemoryTransport(),
  };
  const declared = {} as Instances['declared'];
  for (const column of COLUMNS) {
    declared[column] = { ...transports[column].capabilities };
    await transports[column].close().catch(() => {});
  }
  return declared;
}

function duration(ms: number): string {
  if (!Number.isFinite(ms)) return 'unbounded';
  if (ms === 0) return '0 (no delivery delay)';
  if (ms % 1000 === 0 && ms >= 1000) return `${ms.toLocaleString('en-US')} ms (${ms / 1000} s)`;
  return `${ms.toLocaleString('en-US')} ms`;
}

function capabilityTable(declared: Instances['declared']): string {
  const rows: Array<[string, (c: Instances['declared'][Column]) => string]> = [
    ['`maxDeliverDelayMs`: how far ahead a bell can be rung', (c) => duration(c.maxDeliverDelayMs)],
    ['`maxRingBatch`: bells per `ring` call', (c) => String(c.maxRingBatch)],
    ['`attemptCount`: delivery attempt number', (c) => `\`${c.attemptCount}\``],
    ['`retryGranularityMs`: finest retry delay (Postgres: its poll interval, default shown)', (c) => duration(c.retryGranularityMs)],
  ];
  const head = `| Capability | ${COLUMNS.map((c) => COLUMN_TITLES[c]).join(' | ')} |`;
  const rule = `| --- | ${COLUMNS.map(() => '---').join(' | ')} |`;
  const body = rows.map(
    ([label, read]) => `| ${label} | ${COLUMNS.map((c) => read(declared[c])).join(' | ')} |`
  );
  return [head, rule, ...body].join('\n');
}

function statsTable(): string {
  const minutes = (ms: number) => `${ms / 60_000} min`;
  return [
    '| Transport | `source` | `maxStalenessMs` |',
    '| --- | --- | --- |',
    `| Pub/Sub | \`cloud-monitoring\` or \`unavailable\` | ${MONITORING_LAG_MS.toLocaleString('en-US')} (${minutes(MONITORING_LAG_MS)}) plus the cache period |`,
    `| SQS | \`sqs-queue-attributes\`, with \`+cloudwatch\` when age is read | ${ATTRIBUTES_LAG_MS.toLocaleString('en-US')} (${minutes(ATTRIBUTES_LAG_MS)}) for counts; ${CLOUDWATCH_LAG_MS.toLocaleString('en-US')} (${minutes(CLOUDWATCH_LAG_MS)}) plus the cache period with age |`,
    '| Postgres | `postgres-counts` | 0 |',
    '| Memory | `memory` | 0 |',
  ].join('\n');
}

function skipsTable(): string {
  const rows: string[] = [];
  for (const [transport, skips] of Object.entries(CONTRACT_SKIPS)) {
    for (const [behaviour, reason] of Object.entries(skips)) {
      rows.push(`| Contract suite | \`${transport}\` | \`${behaviour}\` | ${reason} |`);
    }
  }
  for (const scenario of allScenarios) {
    for (const [stack, reason] of Object.entries(scenario.skip ?? {})) {
      rows.push(`| Scenario: ${scenario.name} | \`${stack}\` | n/a | ${reason} |`);
    }
  }
  return [
    '| Suite | Transport | Behaviour | Why it is skipped |',
    '| --- | --- | --- | --- |',
    ...rows,
  ].join('\n');
}

export async function renderTransportsDoc(): Promise<string> {
  const declared = await declaredCapabilities();
  const header = `| | ${COLUMNS.map((c) => COLUMN_TITLES[c]).join(' | ')} |`;
  const matrix = [
    header,
    `| --- | ${COLUMNS.map(() => '---').join(' | ')} |`,
    ...MATRIX.map((row) => `| ${row.join(' | ')} |`),
  ].join('\n');
  const emulator = [
    '| What | How the emulator differs from the service |',
    '| --- | --- |',
    ...EMULATOR_ONLY.map(([what, difference]) => `| ${what} | ${difference} |`),
  ].join('\n');
  const delay = [
    '| Mode | Figure (the same words as [limits.md](limits.md) section 1) |',
    '| --- | --- |',
    ...DELAY_FIGURES.map(([mode, figure]) => `| ${mode} | ${figure} |`),
  ].join('\n');
  const sqsWindow = declared['aws-sqs'].maxDeliverDelayMs / 1000;
  return `# Transports

What each broker does behind the one \`DeliveryTransport\` interface, and where they differ. A difference is a
capability flag below or a row in the matrix; nothing above \`packages/transports\` branches on a broker, and
\`bun run architecture\` enforces it. The same contract suite (\`test/contract\`) and the same end-to-end scenarios
(\`test/scenarios\`) run against every transport, so a behaviour listed as common is tested on each.

**How to read the evidence.** \`declared\`: read from the code by the generator. \`emulator\`: a test against the
Pub/Sub emulator or ElasticMQ, which is **emulator only** evidence (section 4 lists where they differ). \`tested\`: a
test against real Postgres or in the process. \`design\`: reasoned, not run. \`not run\` or \`real: not run\`: the real
service was never touched; decision D9 keeps real clouds behind \`QCLOUD_REAL_CLOUD=1\` and the owner's go-ahead.

This file is generated: \`bun run docs:transports\` rewrites the marked blocks and the hand-written rows live in
\`scripts/transportsDocMatrix.ts\`. \`test/contract/matrix.test.ts\` fails when the file and the code disagree.

## 1. What each transport declares

${BEGIN('capabilities')}
${capabilityTable(declared)}
${END('capabilities')}

Queue statistics freshness, from the \`source\` and \`maxStalenessMs\` each \`stats\` call reports:

${BEGIN('stats')}
${statsTable()}
${END('stats')}

## 2. Compatibility matrix

${BEGIN('matrix')}
${matrix}
${END('matrix')}

## 3. Delay precision

The tick's share of a delayed job's lateness, which is what a user sees on a window-0 transport such as Pub/Sub.
SQS's window is **${sqsWindow} s**, declared above; a delay inside it is the broker's, rounded up to a whole second,
and a longer one is \`delay-too-long\` and left to the tick. The figures are the ones in
[limits.md](limits.md) section 1, measured on the emulators and local Postgres; \`test/contract/matrix.test.ts\`
compares the two files. **Real SQS: not measured.**

${BEGIN('delay')}
${delay}
${END('delay')}

## 4. Emulator only

These rows hold on the emulator and say nothing about the service. A green emulator run is proof of wiring.

${BEGIN('emulator')}
${emulator}
${END('emulator')}

## 5. Skipped behaviours

A transport that lacks a behaviour skips its test with the reason, in code, and the skip is listed here:

${BEGIN('skips')}
${skipsTable()}
${END('skips')}

Delayed-delivery tests run only where \`maxDeliverDelayMs > 0\`. A transport at 0 passes the same end-to-end scenario
through the tick, with its precision stated in section 3.

## 6. Open decision D2: one bell per job or per batch

**SQS: not measured; per job by default.** The choice between a bell per job and one per batch of jobs was measured
only against the local broker; a load test of both granularities on real SQS is behind \`QCLOUD_REAL_CLOUD=1\` and
D9, and has not been run. Until it is, every transport rings one bell per job.

## 7. Running it

\`\`\`bash
bun run test:contract  --transport=local,gcp-emulator,aws-emulator
bun run test:scenarios --transport=local,gcp-emulator,aws-emulator
\`\`\`

\`local\` is the memory and Postgres transports and needs only Postgres. \`gcp-emulator\` needs the Pub/Sub emulator on
\`127.0.0.1:58085\` and \`aws-emulator\` ElasticMQ on \`127.0.0.1:59324\` (see \`CLAUDE.md\`). An emulator that is down
fails the run rather than skipping it. \`gcp\` and \`aws\` are the real clouds: refused unless \`QCLOUD_REAL_CLOUD=1\`,
and no real-cloud stack exists until task 43.
`;
}
