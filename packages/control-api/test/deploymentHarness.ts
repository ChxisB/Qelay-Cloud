import { expect } from 'bun:test';
import { MemoryTransport } from '@qelay-cloud/transport-local';
import type { ControlApiDeps, ControlApiOptions } from '../src';
import type { JobsFixture } from './jobsFixture';
import type { Harness } from './support';
import { bodyOf, fakeReadiness, harness } from './support';

export type Wire = Record<string, any>;

/**
 * The helpers the `GET /deployment` suites share. The fixture is opened in `beforeAll`, after the
 * suite is declared, so it is passed as a getter and read when a test runs.
 */
export function deploymentHarness(fixture: () => JobsFixture) {
  const open = (
    options: Partial<ControlApiOptions> = {},
    deps: Partial<ControlApiDeps> = {},
    withJobs = true
  ): Harness => {
    const f = fixture();
    return harness(
      { rateLimit: false, ...options, deployment: { cacheMs: 0, ...options.deployment } },
      {
        ...(withJobs
          ? { jobs: { store: f.store, transport: new MemoryTransport({ clock: f.t.clock }) } }
          : {}),
        ...deps,
      },
      f.t.clock
    );
  };

  const deployment = async (api: Harness): Promise<Wire> => {
    const response = await api.call('GET', '/deployment');
    expect(response.status).toBe(200);
    return (await bodyOf(response)) as Wire;
  };
  const codes = (body: Wire): string[] => body.warnings.map((warning: Wire) => warning.code);

  /** A tick row whose last success was `agoMs` ago, as the database clock reports it. */
  const tickedAgo = (agoMs: number | null): ControlApiDeps['readiness'] => {
    const { clock } = fixture().t;
    return fakeReadiness({
      tick: async () => ({
        lastSuccessAt: agoMs === null ? null : clock.now() - agoMs,
        lastFailureAt: null,
        now: clock.now(),
      }),
    });
  };

  return { open, deployment, codes, tickedAgo };
}
