import { expect, test } from 'bun:test';
import { describeSqs } from '../../packages/transport-aws/test/support';
import { describePubsub } from '../../packages/transport-gcp/test/support';
import { Ledger, reconcile, until, untilFinished } from '../scenarios/scenario';
import { openStack } from '../scenarios/stack';
import type { StackKind } from '../scenarios/stack';
import { operator, targetOf } from './support';

/**
 * docs/runbooks/transport-dead-letters.md, against the two brokers' emulators: a bell nobody can read
 * ends in the broker's dead-letter queue, the runbook's route shows it, and the jobs behind it are
 * not affected. Clearing the leftovers (`gcloud pubsub subscriptions seek`, `aws sqs purge-queue`) is
 * not run: the emulators are not the provider's commands.
 */
const drill = (kind: StackKind, transport: string, depthFromBroker: boolean) => async () => {
  const s = await openStack(kind);
  try {
    const api = operator({ ...targetOf(s), name: transport });
    const ran = new Ledger();
    s.worker((job) => void ran.record(job.id, job.attemptsMade));
    await s.poison!('jobs');
    const job = await s.queue().add('behind-the-poison', {});
    await untilFinished(s, [job.id]);

    const path = '/transport/dead-letters?queue=jobs';
    const found = await until(
      'the dead letter',
      async () => {
        const body = await api.get(path);
        return body.available === true && body.items.length > 0 ? body : null;
      },
      (s.deadLetterAfterMs ?? 60_000) + 20_000
    );
    expect(found.items[0]).toMatchObject({ jobId: null, jobExists: false }); // not a bell of ours: no job to look at
    // The row the alert reads. Pub/Sub's comes from Cloud Monitoring, which its emulator does not have.
    const row = (await api.get('/transport')).queues.find((q: any) => q.queue === 'jobs');
    if (depthFromBroker) expect(row.deadLetterDepth).toBeGreaterThanOrEqual(1);
    else expect(row.deadLetterDepth).toBeNull();
    expect(ran.count(job.id)).toBe(1);
    await reconcile(s, [job.id]);
  } finally {
    await s.drop();
  }
};

describePubsub('game day: Pub/Sub dead letters', () => {
  test(
    'a poison bell is dead-lettered, visible, and costs no job',
    drill('pubsub', 'gcp-pubsub', false),
    150_000
  );
});

describeSqs('game day: SQS dead letters', () => {
  test(
    'a poison bell is dead-lettered, visible, and costs no job',
    drill('sqs', 'aws-sqs', true),
    200_000
  );
});
