import type { Clock } from '@qelay-cloud/core';
import type { TtlCache } from '../cache';
import type { ResolvedConfig } from '../config';
import type { ControlApiDeps, JobsDeps } from '../deps';
import type { Logger } from '../http/log';

/** What the Transport and Deployment routes share: the deployment's wiring and one short-lived cache. */
export interface OpsContext {
  readonly deps: ControlApiDeps;
  readonly config: ResolvedConfig;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly cache: TtlCache;
  /** The store and broker, absent when the deployment serves no jobs routes. */
  readonly jobs: JobsDeps | null;
}

/** Runs `work` and gives its result, or null when it throws or takes longer than `ms`. Never rejects. */
export async function settled<T>(work: () => Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  try {
    return await Promise.race([work().catch(() => null), late]);
  } finally {
    clearTimeout(timer);
  }
}
