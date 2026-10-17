import type { SQSClient } from '@aws-sdk/client-sqs';
import { GetQueueUrlCommand } from '@aws-sdk/client-sqs';
import type { SqsMetrics } from './metrics';

/**
 * Queue URLs by queue name, looked up once. SQS addresses a queue by URL, which holds the account
 * id; the transport only knows names. A failed lookup is not remembered, so a queue that is created
 * later is found by the next call.
 */
export class QueueUrls {
  readonly #client: SQSClient;
  readonly #metrics: SqsMetrics;
  readonly #known = new Map<string, Promise<string>>();

  constructor(client: SQSClient, metrics: SqsMetrics) {
    this.#client = client;
    this.#metrics = metrics;
  }

  url(name: string): Promise<string> {
    let known = this.#known.get(name);
    if (!known) {
      this.#metrics.queueUrlLookups += 1;
      known = this.#client.send(new GetQueueUrlCommand({ QueueName: name })).then((out) => {
        if (!out.QueueUrl) throw new Error(`SQS returned no URL for the queue "${name}"`);
        return out.QueueUrl;
      });
      this.#known.set(name, known);
      known.catch(() => {
        if (this.#known.get(name) === known) this.#known.delete(name);
      });
    }
    return known;
  }
}
