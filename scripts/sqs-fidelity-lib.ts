/** What the fidelity probes share: the target (emulator or real), a throwaway queue, and the report. */
import { randomBytes } from 'node:crypto';
import type { Message } from '@aws-sdk/client-sqs';
import { ReceiveMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import type { QueueSettings } from '../packages/transport-aws/src';
import { ensureQueue, removeQueue } from '../packages/transport-aws/src';

export const real = process.argv.includes('--real');
const regionIndex = process.argv.indexOf('--region');
export const region = regionIndex >= 0 ? process.argv[regionIndex + 1] : undefined;
export const endpoint = process.env.QCLOUD_SQS_ENDPOINT ?? 'http://127.0.0.1:59324';
if (!real && !['127.0.0.1', 'localhost'].includes(new URL(endpoint).hostname)) {
  throw new Error('without --real this tool only talks to a loopback emulator');
}
if (real && !region) throw new Error('--real needs an explicit --region');

export interface Topology {
  readonly client: SQSClient;
  readonly queueUrl: string;
  readonly deadLetterUrl: string;
  destroy(): Promise<void>;
}

/** A fresh queue with a dead-letter queue, in a namespace of its own. */
export async function createTopology(settings: QueueSettings = {}): Promise<Topology> {
  const client = real
    ? new SQSClient({ region: region!, maxAttempts: 1 })
    : new SQSClient({
        endpoint,
        region: 'us-east-1',
        credentials: { accessKeyId: 'qcloud-test', secretAccessKey: 'qcloud-test' },
        maxAttempts: 1,
      });
  const namespace = `fidelity${randomBytes(4).toString('hex')}`;
  const { queueUrl, deadLetterUrl } = await ensureQueue(client, namespace, 'probe', {
    visibilityTimeoutSeconds: 3,
    ...settings,
  });
  let destroyed = false;
  return {
    client,
    queueUrl,
    deadLetterUrl,
    async destroy() {
      if (destroyed) return;
      destroyed = true;
      await removeQueue(client, namespace, 'probe').catch(() => {});
      client.destroy();
    },
  };
}

/** What is receivable right now, without waiting. */
export async function receiveNow(
  client: SQSClient,
  queueUrl: string,
  max = 10,
  visibilityTimeout = 0
): Promise<Message[]> {
  const { Messages } = await client.send(
    new ReceiveMessageCommand({
      QueueUrl: queueUrl,
      MaxNumberOfMessages: max,
      WaitTimeSeconds: 0,
      VisibilityTimeout: visibilityTimeout,
      MessageSystemAttributeNames: ['ApproximateReceiveCount'],
    })
  );
  return Messages ?? [];
}


const errorName = (error: unknown) =>
  error instanceof Error ? `${error.name}: ${error.message.slice(0, 90)}` : String(error);

export async function attempt<T>(
  run: () => Promise<T>
): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    return { ok: false, error: errorName(error) };
  }
}

export const rows: Array<{ probe: string; emulator: string; aws: string }> = [];
export const report = (probe: string, emulator: unknown, aws: string) =>
  rows.push({ probe, emulator: String(emulator), aws });

