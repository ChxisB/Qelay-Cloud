/**
 * Runs the contract suite or the end-to-end scenarios against the transports named, one `bun test`
 * with the right files and variables:
 *
 *   bun run test:contract  [--transport=local,gcp-emulator,aws-emulator]
 *   bun run test:scenarios [--transport=local,gcp-emulator,aws-emulator] [--suite=workflows]
 *
 * With no `--transport` every emulator name runs. An emulator that is not reachable fails the run
 * (`QCLOUD_REQUIRE_*` is set), because a pass that skipped a transport is not a pass. `gcp` and
 * `aws` mean a real cloud and are refused unless `QCLOUD_REAL_CLOUD=1`, which is the person's
 * go-ahead to use paid, shared resources (D9).
 */
import type { TransportName } from '../test/support/transports';
import { isTransportName, TRANSPORT_NAMES, TRANSPORT_SELECTORS } from '../test/support/transports';

const SUITES = ['contract', 'scenarios'] as const;
type Suite = (typeof SUITES)[number];

const DEFAULT_NAMES: readonly TransportName[] = TRANSPORT_NAMES.filter(
  (name) => !TRANSPORT_SELECTORS[name].real
);

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

export function parseArgs(argv: readonly string[]): {
  suite: Suite;
  names: TransportName[];
  group?: string;
} {
  const [suite, ...rest] = argv;
  if (suite === undefined || !(SUITES as readonly string[]).includes(suite)) {
    fail(`usage: test-transport.ts <${SUITES.join('|')}> [--transport=${TRANSPORT_NAMES.join(',')}]`);
  }
  let names: TransportName[] = [...DEFAULT_NAMES];
  let group: string | undefined;
  for (const arg of rest) {
    const picked = /^--suite=(.+)$/.exec(arg);
    if (picked !== null) {
      if (suite !== 'scenarios') fail('--suite applies to the scenarios only');
      group = picked[1]!;
      continue;
    }
    const match = /^--transport=(.+)$/.exec(arg);
    if (match === null) fail(`Unknown argument "${arg}"`);
    names = [];
    for (const raw of match[1]!.split(',').map((part) => part.trim())) {
      if (!isTransportName(raw)) fail(`Unknown transport "${raw}" (one of ${TRANSPORT_NAMES.join(', ')})`);
      names.push(raw);
    }
  }
  return { suite: suite as Suite, names, ...(group === undefined ? {} : { group }) };
}

if (import.meta.main) {
  const { suite, names, group } = parseArgs(process.argv.slice(2));
  const real = names.filter((name) => TRANSPORT_SELECTORS[name].real);
  if (real.length > 0 && process.env.QCLOUD_REAL_CLOUD !== '1') {
    fail(
      `${real.join(', ')} is a real cloud: it costs money and uses shared resources. ` +
        'Set QCLOUD_REAL_CLOUD=1 only with the owner\'s go-ahead (decision D9).'
    );
  }
  if (real.length > 0) {
    fail(
      `${real.join(', ')}: no real-cloud stack exists yet (task 43 builds it, behind D9). ` +
        'Run the emulator names meanwhile.'
    );
  }
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    QCLOUD_REQUIRE_DB: '1',
  };
  const files: string[] = [];
  for (const name of names) {
    const selector = TRANSPORT_SELECTORS[name];
    Object.assign(env, selector.require);
    files.push(...selector.contract);
  }
  if (suite === 'scenarios') env.QCLOUD_SCENARIO_TRANSPORTS = names.join(',');
  if (group !== undefined) env.QCLOUD_SCENARIO_SUITE = group;
  const targets = suite === 'contract' ? files : ['test/scenarios'];
  console.log(`${suite}: ${names.join(', ')}`);
  const run = Bun.spawnSync(['bun', 'test', ...targets], { env, stdio: ['inherit', 'inherit', 'inherit'] });
  process.exit(run.exitCode ?? 1);
}
