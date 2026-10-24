import { ModelCommand } from './command';
import { verifyOutcome } from './invariants';
import { stateOf } from './model';
import type { RingFault } from './transport';
import type { World } from './world';
import { QUEUES } from './world';

/**
 * An operator retries a dead-lettered job (`retry-dlq`). It aims at a failed job, or with `any` at
 * any id the model knows, so the refusals are exercised too: a job that is not failed answers
 * `not_failed` and a gone one `not_found`, and neither changes anything. A retried job is ready at
 * once with no attempt used and rings; its DLQ entry is gone, so the rewrite check starts over.
 */
export class RetryDlqCommand extends ModelCommand {
  readonly name = 'retryDlq';

  constructor(
    private readonly pick: number,
    private readonly any: boolean,
    private readonly fault: RingFault
  ) {
    super();
  }

  protected async apply(world: World): Promise<void> {
    const ids = this.any
      ? world.model.knownIds()
      : [...world.model.jobs.values()].filter((job) => job.phase === 'failed').map((job) => job.id);
    const id = ids[this.pick % Math.max(ids.length, 1)];
    if (id === undefined) return;
    const job = world.model.jobs.get(id);
    const now = world.now();
    const what = `retryDlq ${id} (${job ? stateOf(job, now) : 'gone'})`;
    const expected = job?.phase === 'failed';
    const result = await world.store.retryDlq(job?.queue ?? QUEUES[0], id);
    verifyOutcome(world, what, result.ok, expected, false);
    if (!result.ok) {
      const want = job ? 'not_failed' : 'not_found';
      if (!expected && result.reason !== want) {
        world.violate('MODEL.outcome', `${what} was refused as ${result.reason}, not ${want}`);
      }
      return;
    }
    if (!expected || !job) return;
    world.model.retryDlq(job, now);
    world.dlqSeen.delete(`${id}#${job.generation}`);
    if (!result.rings.some((ring) => ring.bell.jobId === id && ring.dueInMs === 0)) {
      world.violate('MODEL.outcome', `${what} returned no ring for the job it put back`);
    }
    await world.ring(result.rings, this.fault);
  }

  toString(): string {
    return `retryDlq(${this.any ? 'any' : 'failed'}#${this.pick} ring=${this.fault})`;
  }
}
