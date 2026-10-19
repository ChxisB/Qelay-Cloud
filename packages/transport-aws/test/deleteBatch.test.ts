import { expect, test } from 'bun:test';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { DELETE_FLUSH_MS, DeleteBatcher, MAX_DELETE_BATCH } from '../src/deleteBatch';
import { newMetrics } from '../src/metrics';
import type { QueueUrls } from '../src/queueUrls';
import { awsError } from './stub';

interface Entry {
  Id: string;
  ReceiptHandle: string;
}

/** A broker-free client that records each DeleteMessageBatch and answers as the test says. */
function rig(answer: (entries: Entry[]) => unknown = () => ({})) {
  const calls: Entry[][] = [];
  const errors: Error[] = [];
  const metrics = newMetrics();
  const client = {
    send: async (command: { input: { Entries: Entry[] } }) => {
      calls.push(command.input.Entries);
      return answer(command.input.Entries);
    },
  };
  const batcher = new DeleteBatcher({
    client: client as unknown as SQSClient,
    urls: { url: async () => 'http://stub/q' } as unknown as QueueUrls,
    queueName: 'q',
    metrics,
    onError: (error) => errors.push(error),
  });
  const sizes = () => calls.map((entries) => entries.length);
  return { batcher, metrics, errors, calls, sizes };
}

const addAll = (batcher: DeleteBatcher, count: number) =>
  Array.from({ length: count }, (_, n) => batcher.add(`h${n}`));

test('ten handles go out at once, as one request', async () => {
  const { batcher, sizes, calls } = rig();
  addAll(batcher, MAX_DELETE_BATCH);
  await batcher.drain();
  expect(sizes()).toEqual([10]);
  expect(calls[0]!.map((entry) => entry.ReceiptHandle)).toEqual(
    Array.from({ length: 10 }, (_, n) => `h${n}`)
  );
  expect(new Set(calls[0]!.map((entry) => entry.Id)).size).toBe(10);
});

test('a short batch waits for the flush time, and 25 handles are 10, 10 and 5', async () => {
  const { batcher, sizes, metrics } = rig();
  addAll(batcher, 3);
  expect(sizes()).toEqual([]);
  await Bun.sleep(DELETE_FLUSH_MS * 4);
  expect(sizes()).toEqual([3]);
  addAll(batcher, 22);
  await batcher.drain();
  expect(sizes()).toEqual([3, 10, 10, 2]);
  expect(metrics.deletes).toBe(4);
  expect(metrics.deletedBells).toBe(25);
});

test('drain sends what is held without waiting for the timer', async () => {
  const { batcher, sizes } = rig();
  addAll(batcher, 2);
  await batcher.drain();
  expect(sizes()).toEqual([2]);
});

test('an entry SQS reports as stale is counted quietly, any other failure is reported once', async () => {
  const { batcher, metrics, errors } = rig(() => ({
    Failed: [
      { Id: '0', Code: 'ReceiptHandleIsInvalid', SenderFault: true },
      { Id: '1', Code: 'InternalError', SenderFault: false },
      { Id: '2', Code: 'InternalError', SenderFault: false },
    ],
  }));
  addAll(batcher, 4);
  await batcher.drain();
  expect(metrics.staleHandles).toBe(1);
  expect(metrics.deleteErrors).toBe(2);
  expect(errors).toHaveLength(1);
  expect(errors[0]!.message).toContain('InternalError');
});

test('a request that throws counts every bell in it and never rejects', async () => {
  const { batcher, metrics, errors } = rig(() => {
    throw awsError('ServiceUnavailable', 503);
  });
  addAll(batcher, 4);
  await batcher.drain();
  expect(metrics.deleteErrors).toBe(4);
  expect(errors).toHaveLength(1);
});
