import type { SQSClient } from '@aws-sdk/client-sqs';
import type { Bell } from '@qelay-cloud/core';
import type { SqsTransportOptions } from '../src';
import { SqsTransport } from '../src';

export interface Entry {
  Id: string;
  MessageBody: string;
  DelaySeconds?: number;
}

interface Command {
  readonly constructor: { readonly name: string };
  readonly input: { Entries?: Entry[]; QueueName?: string; QueueUrl?: string };
}

export interface Call {
  readonly queueUrl: string;
  readonly entries: Entry[];
}

/** A broker-free client: records each SendMessageBatch and answers as the test says. */
export function stubbed(
  answer: (entries: Entry[], call: number, queueUrl: string) => unknown,
  options: Partial<SqsTransportOptions> = {}
) {
  const calls: Call[] = [];
  const lookups: string[] = [];
  const client = {
    send: async (command: Command) => {
      const kind = command.constructor.name;
      if (kind === 'GetQueueUrlCommand') {
        lookups.push(command.input.QueueName ?? '');
        return { QueueUrl: `http://stub/${command.input.QueueName}` };
      }
      if (kind !== 'SendMessageBatchCommand') throw new Error(`stub: unexpected ${kind}`);
      const entries = command.input.Entries ?? [];
      const queueUrl = command.input.QueueUrl ?? '';
      calls.push({ queueUrl, entries });
      return await answer(entries, calls.length - 1, queueUrl);
    },
    destroy: () => {},
  };
  const transport = new SqsTransport({
    namespace: 'stub',
    client: client as unknown as SQSClient,
    monitoring: false,
    ...options,
  });
  return { transport, calls, lookups };
}

export const bells = (count: number, queue = 'q'): Bell[] =>
  Array.from({ length: count }, (_, n) => ({ namespace: 'stub', queue, jobId: String(n) }));

/** An error as the AWS SDK raises it. */
export function awsError(
  name: string,
  status: number,
  fault: 'client' | 'server' = status >= 500 ? 'server' : 'client'
): Error {
  return Object.assign(new Error(`${name} (stub)`), {
    name,
    $fault: fault,
    $metadata: { httpStatusCode: status },
  });
}
