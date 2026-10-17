import { verifyCrons } from './invariants-cron';
import type { ModelJob } from './model';
import { brokenOrderRule, compareClaimOrder, isLegalMove, isTerminal, stateOf } from './model';
import type { ClaimedJob, DlqEntry } from './store';
import type { World } from './world';
import { generationOf, QUEUES } from './world';

/** Runs after every command: every job the model knows matches the store (I1, I2, I4, I5). */
export async function verifyWorld(world: World): Promise<void> {
  const now = world.now();
  for (const job of world.model.jobs.values()) await verifyJob(world, job, now);
  for (const id of world.model.cancelled) {
    const record = await world.store.getJob(id);
    if (record) {
      world.violate(
        'I1.noResurrection',
        `${id} was cancelled but the store reports ${record.state}`
      );
    }
  }
  await verifyDlq(world);
  await verifyCrons(world);
}

async function verifyJob(world: World, job: ModelJob, now: number): Promise<void> {
  const expected = stateOf(job, now);
  const record = await world.store.getJob(job.id);
  if (!record) {
    world.violate(
      'I1.noLoss',
      `${job.id} gen ${job.generation} is ${expected} but the store lost it`
    );
    return;
  }
  const generation = generationOf(record.data);
  if (generation !== job.generation) {
    world.violate(
      generation < job.generation ? 'I1.noLoss' : 'MODEL.state',
      `${job.id} is gen ${generation} in the store, gen ${job.generation} in the model`
    );
    return;
  }
  if (record.attempts > record.maxAttempts) {
    world.violate(
      'I4.attemptsBounded',
      `${job.id} has ${record.attempts} attempts, max ${record.maxAttempts}`
    );
  }
  if (record.attempts !== job.attempts) {
    world.violate(
      'I4.attemptsCounted',
      `${job.id} has ${record.attempts} attempts, the model counts ${job.attempts}`
    );
  }
  const previous = world.observed.get(job.id);
  if (previous?.generation === generation && !isLegalMove(previous.state, record.state)) {
    world.violate('T.legalTransition', `${job.id} moved ${previous.state} -> ${record.state}`);
  }
  world.observed.set(job.id, { generation, state: record.state });
  if (record.state !== expected) {
    const revived = isTerminal(expected) && !isTerminal(record.state);
    const why = revived ? ' (a finished job is live again, or its completion was lost)' : '';
    world.violate(
      revived ? 'I1.noResurrection' : 'MODEL.state',
      `${job.id} is ${record.state} in the store, ${expected} in the model${why}`
    );
  }
  if (expected === 'active') {
    const lease = record.lease;
    if (lease?.owner !== job.leaseOwner || lease.until !== job.leaseUntil) {
      world.violate(
        'I2.singleLiveLease',
        `${job.id} lease is ${lease ? `${lease.owner} until ${lease.until}` : 'missing'}, ` +
          `the model gave ${job.leaseOwner} until ${job.leaseUntil}`
      );
    }
  }
}

async function verifyDlq(world: World): Promise<void> {
  const entries = new Map<string, DlqEntry[]>();
  for (const queue of QUEUES) {
    for (const entry of await world.store.listDlq(queue)) {
      entries.set(entry.jobId, [...(entries.get(entry.jobId) ?? []), entry]);
    }
  }
  for (const [id, list] of entries) {
    const job = world.model.jobs.get(id);
    if (list.length > 1) world.violate('I5.dlqExactlyOnce', `${id} has ${list.length} DLQ entries`);
    if (job?.phase !== 'failed') {
      const state = job ? stateOf(job, world.now()) : 'gone';
      world.violate('I5.dlqExactlyOnce', `${id} is ${state} but has a DLQ entry`);
      continue;
    }
    const key = `${id}#${job.generation}`;
    const first = world.dlqSeen.get(key);
    if (!first) world.dlqSeen.set(key, list[0]!);
    else if (!sameEntry(first, list[0]!)) {
      world.violate('I5.dlqExactlyOnce', `${id} DLQ entry was rewritten`);
    }
  }
  for (const job of world.model.jobs.values()) {
    if (job.phase === 'failed' && !entries.has(job.id)) {
      world.violate('I5.dlqExactlyOnce', `${job.id} failed with no DLQ entry`);
    }
  }
}

function sameEntry(a: DlqEntry, b: DlqEntry): boolean {
  return (
    a.queue === b.queue &&
    a.attempts === b.attempts &&
    a.failedAt === b.failedAt &&
    a.reason === b.reason
  );
}

/**
 * Checks a claim against the model before the model applies it: the jobs were claimable (I1,
 * I2, delay), the count is right under the queue's limits, and no better job was left behind
 * (ordering). Returns the claims the model can apply, and counts them against the rate window.
 */
export function verifyClaim(
  world: World,
  queue: string,
  n: number,
  claimed: readonly ClaimedJob[]
): Array<{ item: ClaimedJob; job: ModelJob }> {
  const now = world.now();
  if (world.model.paused.has(queue) && claimed.length > 0) {
    world.violate('CLAIM.paused', `claim on paused ${queue} took ${claimed.length} jobs`);
  }
  const candidates = world.model.claimable(queue, now);
  const taken: Array<{ item: ClaimedJob; job: ModelJob }> = [];
  for (const item of claimed) {
    const job = world.model.jobs.get(item.id);
    const generation = generationOf(item.data);
    if (!job || job.generation !== generation) {
      world.violate('I1.noResurrection', `claim returned ${item.id} gen ${generation}, not live`);
    } else if (taken.some((claim) => claim.job === job) || job.phase === 'active') {
      world.violate('I2.singleLiveLease', `${job.id} claimed while ${job.leaseOwner} holds it`);
    } else if (job.phase !== 'pending') {
      world.violate('I1.noResurrection', `claim returned ${job.id}, which is ${job.phase}`);
    } else if (job.runAt > now) {
      world.violate('ORDER.delay', `${job.id} claimed ${job.runAt - now} ms before its runAt`);
    } else if (job.queue !== queue) {
      world.violate('CLAIM.count', `claim on ${queue} returned ${job.id} from ${job.queue}`);
    } else {
      if (item.attempts !== job.attempts) {
        world.violate(
          'I4.attemptsCounted',
          `claim of ${job.id} reported ${item.attempts} attempts`
        );
      }
      taken.push({ item, job });
    }
  }
  const room = world.model.capacity(queue, n, now);
  const expected = Math.min(room, candidates.length);
  if (claimed.length > room && room < n) {
    world.violate(
      'CLAIM.limits',
      `claim(${queue}, ${n}) took ${claimed.length}, its rate and concurrency limits allow ${room}`
    );
  } else if (claimed.length !== expected) {
    world.violate(
      'CLAIM.count',
      `claim(${queue}, ${n}) took ${claimed.length}, expected ${expected}`
    );
  }
  const left = candidates.filter((job) => !taken.some((claim) => claim.job === job));
  for (const { job } of taken) {
    const better = left.find((other) => compareClaimOrder(other, job) < 0);
    if (better) {
      world.violate(brokenOrderRule(better, job), `claimed ${job.id} before ${better.id}`);
    }
  }
  world.model.limits.took(queue, taken.length);
  return taken;
}

/** After a tick: every claimable job in an unpaused queue has a doorbell on the way (I3). */
export function verifyNothingStuck(world: World): void {
  const now = world.now();
  for (const queue of QUEUES) {
    const claimable = world.model.claimable(queue, now).length;
    const deliverable = world.bells.deliverable(queue);
    if (deliverable < claimable) {
      world.violate(
        'I3.nothingStuck',
        `${queue} has ${claimable} claimable jobs but ${deliverable} doorbells after a tick ` +
          `(${world.bells.describe()})`
      );
    }
  }
}

/** An operation's result against the model's verdict. Success with a stale lease is I2. */
export function verifyOutcome(
  world: World,
  what: string,
  ok: boolean,
  expected: boolean,
  leased: boolean
): void {
  if (ok === expected) return;
  if (ok && leased) world.violate('I2.staleTokenRejected', `${what} succeeded with a stale lease`);
  else world.violate('MODEL.outcome', `${what} returned ${ok}, expected ${expected}`);
}
