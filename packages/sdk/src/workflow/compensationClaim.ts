/**
 * Process-local ownership for one workflow unwind.
 *
 * This is not a distributed lock and is not meant to be. It stops two drivers in ONE process (a
 * recovery sweep and an operator's resume, say) from reading the same unsettled snapshot and
 * issuing the same reversal twice. Between processes the fence is the store's version
 * compare-and-set (`RunStorage.update`): the unwind's first write moves the run to `compensating`,
 * and a driver that read the row before another driver's write loses it and stands down.
 */

interface ActiveCompensationClaim {
  readonly owner: object;
  readonly settled: Promise<void>;
  readonly finish: () => void;
}

export interface AcquiredCompensationClaim {
  readonly kind: 'acquired';
  release(): void;
}

export interface LostCompensationClaim {
  readonly kind: 'claim-lost';
  readonly sameOwner: boolean;
  readonly settled: Promise<void>;
}

const active = new Map<string, ActiveCompensationClaim>();

export function acquireCompensationClaim(
  executionId: string,
  owner: object
): AcquiredCompensationClaim | LostCompensationClaim {
  const current = active.get(executionId);
  if (current) {
    return {
      kind: 'claim-lost',
      sameOwner: current.owner === owner,
      settled: current.settled,
    };
  }

  let resolveFinished: () => void = () => undefined;
  const settled = new Promise<void>((resolve) => {
    resolveFinished = resolve;
  });
  const claim = { owner, settled, finish: resolveFinished };
  active.set(executionId, claim);
  let released = false;

  return {
    kind: 'acquired',
    release(): void {
      if (released) return;
      released = true;
      if (active.get(executionId) === claim) active.delete(executionId);
      claim.finish();
    },
  };
}
