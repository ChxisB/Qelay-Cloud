import type { CommandName } from './command';
import type { Row } from './fakeRows';
import { FakeStore } from './fakeStore';
import { POSTGRES_COMMANDS, POSTGRES_WORKER_COMMANDS, postgresFactory } from './postgresTarget';
import type { Lease, Outcome, StoreFactory } from './store';
import type { CheckName } from './world';

/** Bug: the claim filter forgets that an active job is taken (a lost `SKIP LOCKED`/state guard). */
class DoubleClaimStore extends FakeStore {
  protected override isClaimCandidate(row: Row, queue: string, now: number): boolean {
    return (
      super.isClaimCandidate(row, queue, now) || (row.queue === queue && row.status === 'active')
    );
  }
}

/**
 * Bug: a heartbeat bumps the row version, the completion's version check then matches no row,
 * and the store reports success anyway. The job stays active and runs again.
 */
class LostCompletionStore extends FakeStore {
  override async complete(lease: Lease, result: unknown): Promise<Outcome> {
    const row = this.held(lease);
    if (row && row.leaseRenewals > 0) return { ok: true, rings: [] };
    return super.complete(lease, result);
  }
}

/** Bug: lease recovery retries the job without counting the expired lease as an attempt. */
class AttemptNotCountedStore extends FakeStore {
  protected override recover(row: Row, now: number): void {
    this.retry(row, now);
  }
}

/** Bug: the tick only rings jobs that were never rung, so a dropped doorbell is never repaired. */
class NoReRingStore extends FakeStore {
  protected override isReRingDue(row: Row): boolean {
    return row.rungAt === null;
  }
}

/** Bug: reusing a finished custom id deletes the old row but leaves its DLQ entry behind. */
class StaleDlqStore extends FakeStore {
  protected override retire(row: Row): void {
    this.rows.delete(row.id);
  }
}

/** Bug: a claim takes whatever `n` asks for, as if the queue had no rate or concurrency limit. */
class LimitIgnoredStore extends FakeStore {
  protected override limitRoom(_queue: string, n: number): number {
    return n;
  }
}

/** Bug: giving a job back counts an attempt, as a failure does. */
class ReleaseCountsAttemptStore extends FakeStore {
  override async release(lease: Lease): Promise<Outcome> {
    const row = this.held(lease);
    if (row) row.attempts += 1;
    return super.release(lease);
  }
}

export const TARGETS = {
  fake: async (env) => new FakeStore(env),
  'double-claim': async (env) => new DoubleClaimStore(env),
  'lost-completion': async (env) => new LostCompletionStore(env),
  'attempt-not-counted': async (env) => new AttemptNotCountedStore(env),
  'no-re-ring': async (env) => new NoReRingStore(env),
  'stale-dlq': async (env) => new StaleDlqStore(env),
  'limit-ignored': async (env) => new LimitIgnoredStore(env),
  'release-counts-attempt': async (env) => new ReleaseCountsAttemptStore(env),
  postgres: postgresFactory,
  'postgres-workers': postgresFactory,
} satisfies Record<string, StoreFactory>;

export type TargetName = keyof typeof TARGETS;

/**
 * The commands a target implements, where it is not all of them. A target absent here runs every
 * command. A store that is being built enables more as its tasks land (12: enqueue; 13: claim, leases, limits; 14-15: the rest).
 */
export const TARGET_COMMANDS: Readonly<Partial<Record<TargetName, readonly CommandName[]>>> = {
  postgres: POSTGRES_COMMANDS,
  'postgres-workers': POSTGRES_WORKER_COMMANDS,
};

/** Targets whose bells go to real `Worker`s (see `workers.ts`) instead of straight to the store. */
export const WORKER_TARGETS: ReadonlySet<string> = new Set<TargetName>(['postgres-workers']);

/** Each planted bug and the check that must catch it. The first five are task 02's, the last two task 13's. */
export const PLANTED_BUGS: Readonly<
  Record<Exclude<TargetName, 'fake' | 'postgres' | 'postgres-workers'>, CheckName>
> = {
  'double-claim': 'I2.singleLiveLease',
  'lost-completion': 'I1.noResurrection',
  'attempt-not-counted': 'I4.attemptsCounted',
  'no-re-ring': 'I3.nothingStuck',
  'stale-dlq': 'I5.dlqExactlyOnce',
  'limit-ignored': 'CLAIM.limits',
  'release-counts-attempt': 'I4.attemptsCounted',
};

export function isTargetName(name: string): name is TargetName {
  return Object.hasOwn(TARGETS, name);
}
