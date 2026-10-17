/**
 * What does the SQS emulator reproduce of SQS's limits, redrive, visibility and polling behaviour?
 * Each probe prints what the service did next to what the AWS documentation says real SQS does
 * (checked 2026-10-13). On the emulator a difference means a test that passes there proves nothing
 * about that behaviour on AWS; on real SQS it is the measurement the emulator is compared with.
 *
 *   bun scripts/sqs-fidelity.ts                  # ElasticMQ on 127.0.0.1:59324, dummy credentials
 *   bun scripts/sqs-fidelity.ts --real --region eu-west-1
 *
 * `--real` uses the default AWS credential chain and creates (then deletes) a few queues in a
 * throwaway `fidelity…` namespace of the account: run it only with the account owner's go-ahead (D9).
 * The output says which one produced it ("emulator" or "real"), because the two are never interchangeable.
 */
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageBatchCommand,
  SendMessageCommand,
} from '@aws-sdk/client-sqs';
import type { Topology } from './sqs-fidelity-lib';
import {
  attempt,
  createTopology,
  endpoint,
  real,
  receiveNow,
  region,
  report,
  rows,
} from './sqs-fidelity-lib';

/** DelaySeconds at the limit, one over it, and a batch with one bad entry. */
async function probeDelay(t: Topology) {
  const send = (delay: number) =>
    attempt(() =>
      t.client.send(
        new SendMessageCommand({ QueueUrl: t.queueUrl, MessageBody: '{}', DelaySeconds: delay })
      )
    );
  const at = await send(900);
  const over = await send(901);
  report('DelaySeconds 900', at.ok ? 'accepted' : at.error, 'accepted (0-900)');
  report('DelaySeconds 901', over.ok ? 'ACCEPTED' : over.error, 'InvalidParameterValue');
  const batch = await attempt(() =>
    t.client.send(
      new SendMessageBatchCommand({
        QueueUrl: t.queueUrl,
        Entries: [
          { Id: 'good', MessageBody: '{}' },
          { Id: 'bad', MessageBody: '{}', DelaySeconds: 901 },
        ],
      })
    )
  );
  report(
    'batch with one DelaySeconds 901 entry',
    batch.ok
      ? `ok; Successful=${batch.value.Successful?.length} Failed=${batch.value.Failed?.length}`
      : batch.error,
    'whole request rejected, or a Failed entry (docs allow both)'
  );
  const eleven = await attempt(() =>
    t.client.send(
      new SendMessageBatchCommand({
        QueueUrl: t.queueUrl,
        Entries: Array.from({ length: 11 }, (_, n) => ({ Id: String(n), MessageBody: '{}' })),
      })
    )
  );
  report('batch of 11', eleven.ok ? 'ACCEPTED' : eleven.error, 'TooManyEntriesInBatchRequest');
  const attrs = await t.client.send(
    new GetQueueAttributesCommand({ QueueUrl: t.queueUrl, AttributeNames: ['All'] })
  );
  report(
    'Delayed count right after sending',
    attrs.Attributes?.ApproximateNumberOfMessagesDelayed,
    'approximate, up to a minute stale'
  );
}

/** How many receives before the redrive moves a message, and what ReceiveCount says. */
async function probeRedrive(max: number) {
  const t = await createTopology({ visibilityTimeoutSeconds: 1, maxReceiveCount: max });
  try {
    await t.client.send(new SendMessageCommand({ QueueUrl: t.queueUrl, MessageBody: 'poison' }));
    const counts: number[] = [];
    for (let round = 0; round < max + 3; round++) {
      const [message] = await receiveNow(t.client, t.queueUrl, 1, 0);
      if (message) counts.push(Number(message.Attributes?.ApproximateReceiveCount));
      await Bun.sleep(120);
    }
    const inDlq = (await receiveNow(t.client, t.deadLetterUrl, 10, 0)).length;
    report(
      `redrive, maxReceiveCount=${max}: receives of the main queue`,
      `${counts.length} (counts ${counts.join(',')}), DLQ has ${inDlq}`,
      `${max} receives, then the move happens on receive ${max + 1} (ReceiveCount exceeds the max)`
    );
  } finally {
    await t.destroy();
  }
}

/** A delete with the handle of an earlier receive, after the message was received again. */
async function probeStaleHandle() {
  const t = await createTopology({ visibilityTimeoutSeconds: 1 });
  try {
    await t.client.send(new SendMessageCommand({ QueueUrl: t.queueUrl, MessageBody: 'x' }));
    const [first] = await receiveNow(t.client, t.queueUrl, 1, 1);
    await Bun.sleep(1_400);
    const [second] = await receiveNow(t.client, t.queueUrl, 1, 30);
    const stale = await attempt(() =>
      t.client.send(
        new DeleteMessageCommand({ QueueUrl: t.queueUrl, ReceiptHandle: first!.ReceiptHandle! })
      )
    );
    const stillThere = await attempt(() =>
      t.client.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: t.queueUrl,
          ReceiptHandle: second!.ReceiptHandle!,
          VisibilityTimeout: 0,
        })
      )
    );
    report(
      'delete with a stale receipt handle',
      `${stale.ok ? 'no error' : stale.error}; the message is ${stillThere.ok ? 'STILL THERE (not deleted)' : 'gone'}`,
      'may return success without deleting (documented); never relied on'
    );
  } finally {
    await t.destroy();
  }
}

/** ChangeMessageVisibility as a nack: 0 s and 1 s, and the long-poll wake-up. */
async function probeTiming() {
  const t = await createTopology({ visibilityTimeoutSeconds: 30 });
  try {
    const timeUntilReceivable = async (seconds: number) => {
      await t.client.send(new SendMessageCommand({ QueueUrl: t.queueUrl, MessageBody: 'n' }));
      const [message] = await receiveNow(t.client, t.queueUrl, 1, 30);
      const start = performance.now();
      await t.client.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: t.queueUrl,
          ReceiptHandle: message!.ReceiptHandle!,
          VisibilityTimeout: seconds,
        })
      );
      for (;;) {
        const [again] = await receiveNow(t.client, t.queueUrl, 1, 0);
        if (again) {
          await t.client.send(
            new DeleteMessageCommand({ QueueUrl: t.queueUrl, ReceiptHandle: again.ReceiptHandle! })
          );
          return Math.round(performance.now() - start);
        }
        await Bun.sleep(25);
      }
    };
    report(
      'nack with VisibilityTimeout 0: back after (ms)',
      await timeUntilReceivable(0),
      'immediately'
    );
    report('nack with VisibilityTimeout 1: back after (ms)', await timeUntilReceivable(1), '1 s');

    const longPoll = async (sendAfterMs: number | null) => {
      const start = performance.now();
      const pending = t.client.send(
        new ReceiveMessageCommand({
          QueueUrl: t.queueUrl,
          WaitTimeSeconds: 2,
          MaxNumberOfMessages: 1,
        })
      );
      if (sendAfterMs !== null) {
        await Bun.sleep(sendAfterMs);
        await t.client.send(new SendMessageCommand({ QueueUrl: t.queueUrl, MessageBody: 'wake' }));
      }
      const out = await pending;
      for (const message of out.Messages ?? []) {
        await t.client.send(
          new DeleteMessageCommand({ QueueUrl: t.queueUrl, ReceiptHandle: message.ReceiptHandle! })
        );
      }
      return `${Math.round(performance.now() - start)} ms, ${out.Messages?.length ?? 0} message(s)`;
    };
    report('long poll (2 s) on an empty queue', await longPoll(null), 'about 2 s, empty');
    report(
      'long poll, message sent after 500 ms',
      await longPoll(500),
      'returns on arrival, about 500 ms'
    );

    const sentAt = performance.now();
    await t.client.send(
      new SendMessageCommand({ QueueUrl: t.queueUrl, MessageBody: 'd', DelaySeconds: 2 })
    );
    let first = 0;
    while (!first) {
      if ((await receiveNow(t.client, t.queueUrl, 1, 0)).length > 0)
        first = performance.now() - sentAt;
      else await Bun.sleep(50);
    }
    report(
      'DelaySeconds 2: first receivable after (ms)',
      Math.round(first),
      'about 2,000, never earlier'
    );
  } finally {
    await t.destroy();
  }
}

/** One receive of up to 10 from a full queue, and attribute freshness. */
async function probeBatching() {
  const t = await createTopology();
  try {
    for (let start = 0; start < 30; start += 10) {
      await t.client.send(
        new SendMessageBatchCommand({
          QueueUrl: t.queueUrl,
          Entries: Array.from({ length: 10 }, (_, n) => ({
            Id: String(n),
            MessageBody: String(start + n),
          })),
        })
      );
    }
    const attrs = await t.client.send(
      new GetQueueAttributesCommand({
        QueueUrl: t.queueUrl,
        AttributeNames: ['ApproximateNumberOfMessages'],
      })
    );
    report(
      'depth right after sending 30',
      attrs.Attributes?.ApproximateNumberOfMessages,
      'approximate, may lag'
    );
    const sizes: number[] = [];
    for (let round = 0; round < 4; round++) {
      sizes.push((await receiveNow(t.client, t.queueUrl, 10, 30)).length);
    }
    report(
      'receive(10) x4 from 30 messages',
      sizes.join(','),
      '10,10,10,0 is not guaranteed: fewer per call is allowed'
    );
  } finally {
    await t.destroy();
  }
}

console.log(`SQS fidelity probes against ${real ? `real SQS in ${region}` : `the emulator at ${endpoint}`}\n`);
const t = await createTopology();
try {
  await probeDelay(t);
} finally {
  await t.destroy();
}
await probeRedrive(3);
await probeStaleHandle();
await probeTiming();
await probeBatching();
console.log(JSON.stringify({ target: real ? 'real' : 'emulator', rows }, null, 2));
