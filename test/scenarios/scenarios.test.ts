import { describe, test } from 'bun:test';
import { describeSqs } from '../../packages/transport-aws/test/support';
import { describePubsub } from '../../packages/transport-gcp/test/support';
import { describeDb } from '../support/db';
import { selectedStacks } from '../support/transports';
import { allScenarios as scenarios } from './all';
import { openStack } from './stack';

/**
 * The scenario suite of the Phase 1 gate (`bun run test:scenarios`): the behaviours a user relies on,
 * run through the SDK, the store, a transport and an in-process tick, once per transport. `memory` is
 * the in-process doorbell, `postgres` the Postgres-only one, `pubsub` the Pub/Sub emulator and `sqs`
 * ElasticMQ (each skipped with a warning when it is down, unless QCLOUD_REQUIRE_PUBSUB=1 or
 * QCLOUD_REQUIRE_SQS=1). `QCLOUD_SCENARIO_TRANSPORTS` narrows the set by deployment name (see
 * `test/support/transports.ts`). Time is real, and the two scenarios that need an hour or ten minutes
 * pull the clock forward in SQL instead of waiting.
 */
const DEFAULT_TIMEOUT_MS = 60_000;

/** `bun run test:scenarios --suite=workflows` runs only the scenarios that name that suite. */
const suite = process.env.QCLOUD_SCENARIO_SUITE || undefined;

const describeFor = {
  memory: describe,
  postgres: describe,
  pubsub: describePubsub,
  sqs: describeSqs,
};

describeDb('scenarios', () => {
  for (const kind of selectedStacks()) {
    describeFor[kind](kind, () => {
      for (const scenario of scenarios) {
        if (suite !== undefined && scenario.suite !== suite) continue;
        const reason = scenario.skip?.[kind];
        // A skipped scenario says why in its name, and `docs/transports.md` lists it.
        const run = reason === undefined ? test : test.skip;
        run(
          reason === undefined ? scenario.name : `${scenario.name} [skipped: ${reason}]`,
          async () => {
            const stack = await openStack(kind, scenario.stack);
            try {
              await scenario.run(stack);
            } finally {
              await stack.drop();
            }
          },
          scenario.timeoutMs ?? DEFAULT_TIMEOUT_MS
        );
      }
    });
  }
});
