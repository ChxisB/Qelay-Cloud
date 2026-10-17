import type { Subscription } from '@qelay-cloud/core';
import type { JobRun } from './jobRunner';
import { within } from './timing';

export interface ShutdownParts {
  readonly graceMs: number;
  readonly timeout: number;
  /** The jobs running now; read again at each step, since the set changes as jobs end. */
  readonly runs: () => ReadonlySet<JobRun>;
  /** Rings after settles that have not finished. */
  readonly rings: () => Iterable<Promise<void>>;
  readonly subscription: Subscription | null;
  /** Removes the registry row. */
  readonly deregister: (timeout: number) => Promise<void>;
  /** Closes what the worker owns: the transport if asked to, then the store. */
  readonly closeOwned: (timeout: number) => Promise<void>;
}

/**
 * The order of a worker's close: jobs get the grace to finish, then they are aborted and released,
 * then the registry row, the subscription and the connections go. Every step after the grace is
 * bounded by `timeout`, so the whole takes at most `graceMs + 2 × timeout` plus scheduling, however
 * the database or the broker behave.
 */
export async function shutdownWorker(parts: ShutdownParts): Promise<void> {
  const { graceMs, timeout } = parts;
  const stopped = parts.subscription?.close();
  const running = () => [...parts.runs()].map((run) => run.done);

  await within(Promise.all(running()), graceMs);

  for (const run of parts.runs()) run.abortForShutdown();
  const half = Math.floor(timeout / 2);
  const windDown = async () => {
    if (await within(Promise.all(running()), half)) return;
    await within(Promise.all([...parts.runs()].map((run) => run.forceRelease())), timeout - half);
  };
  await within(Promise.all([windDown(), within(Promise.all(parts.rings()), timeout)]), timeout);

  await Promise.all([
    parts.deregister(timeout),
    stopped === undefined ? Promise.resolve(true) : within(stopped, timeout),
  ]);
  await within(parts.closeOwned(timeout), timeout + 500);
}
