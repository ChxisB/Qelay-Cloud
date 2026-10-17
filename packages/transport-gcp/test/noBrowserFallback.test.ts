import { afterEach, beforeEach, expect, test } from 'bun:test';
import { environmentNames, PubSubTransport } from '../src';
import type { Environment } from './support';
import {
  describePubsub,
  EMULATOR_PROJECT,
  emulatorClient,
  emulatorHost,
  openEnvironment,
} from './support';

/**
 * A process that has a `window` with a `fetch` (the panel's tests register one, and `bun test` runs every
 * file in one process) makes the Google client libraries pick their browser transport. That transport
 * signs in with the machine's Application Default Credentials, so a suite meant for the emulator would
 * ask Google for a token. The clients here must stay on gRPC whatever globals exist.
 */
type Globals = { window?: unknown };
const globals = globalThis as Globals;
let before: { had: boolean; value: unknown };
let env: Environment;

describePubsub('Pub/Sub clients in a process that looks like a browser', () => {
  beforeEach(async () => {
    env = await openEnvironment({ queues: ['q'] });
    before = { had: 'window' in globals, value: globals.window };
    globals.window = { fetch: globalThis.fetch };
  });
  afterEach(async () => {
    if (before.had) globals.window = before.value;
    else delete globals.window;
    await env.destroy();
  });

  test('the test client reaches the emulator without any credentials', async () => {
    const client = emulatorClient();
    try {
      const [topics] = await client.getTopics();
      expect(topics.map((topic) => topic.name)).toContain(
        `projects/${EMULATOR_PROJECT}/topics/${environmentNames(env.namespace).topic}`
      );
    } finally {
      await client.close().catch(() => {});
    }
  });

  test('a transport that builds its own client for an emulator never leaves gRPC', async () => {
    const transport = new PubSubTransport({
      namespace: env.namespace,
      projectId: EMULATOR_PROJECT,
      emulatorHost: emulatorHost(),
      ringRetryBudgetMs: 1_500,
    });
    try {
      const results = await transport.ring([
        { bell: { namespace: env.namespace, queue: 'q', jobId: 'probe' } },
      ]);
      expect(results).toEqual([{ ok: true }]);
    } finally {
      await transport.close();
    }
  });
});
