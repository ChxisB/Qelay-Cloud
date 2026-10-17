import type { JobsFixture } from './jobsFixture';
import type { StubTransport } from './opsFixture';
import { CAPABILITIES } from './opsFixture';
import type { Harness } from './support';
import { bodyOf, DEV_TOKEN, harness } from './support';

export type Wire = Record<string, any>;

/** The helpers the `GET /transport` suites share; the fixture is read when a test runs. */
export function transportHarness(fixture: () => JobsFixture) {
  const open = (
    transport: StubTransport,
    options: {
      cacheMs?: number;
      maxQueues?: number;
      role?: 'operator' | 'viewer';
      dead?: boolean;
      approximate?: boolean;
    } = {}
  ): Harness => {
    const f = fixture();
    return harness(
      {
        devToken: { token: DEV_TOKEN, role: options.role ?? 'operator' },
        rateLimit: false,
        deployment: { cacheMs: options.cacheMs ?? 0, maxQueues: options.maxQueues ?? 50 },
      },
      {
        transport: {
          name: 'gcp-pubsub',
          capabilities: CAPABILITIES,
          ...(options.dead === false ? { doorbellDeadLetter: false } : {}),
          ...(options.approximate === undefined ? {} : { approximateCounts: options.approximate }),
        },
        jobs: { store: f.store, transport },
      },
      f.t.clock
    );
  };

  const get = async (
    api: Harness,
    path = '/transport'
  ): Promise<{ status: number; body: Wire }> => {
    const response = await api.call('GET', path);
    return { status: response.status, body: (await bodyOf(response)) as Wire };
  };

  return { open, get };
}
