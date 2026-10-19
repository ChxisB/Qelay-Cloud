import type { SQSClient } from '@aws-sdk/client-sqs';
import { DeleteMessageBatchCommand } from '@aws-sdk/client-sqs';
import { isStaleCode, isStaleHandle } from './errors';
import type { SqsMetrics } from './metrics';
import { toError } from './options';
import type { QueueUrls } from './queueUrls';

/** SQS: at most 10 entries in one `DeleteMessageBatch`. */
export const MAX_DELETE_BATCH = 10;
/** How long a delete waits for company before it goes alone. */
export const DELETE_FLUSH_MS = 5;

export interface DeleteBatcherOptions {
  readonly client: SQSClient;
  readonly urls: QueueUrls;
  readonly queueName: string;
  readonly metrics: SqsMetrics;
  readonly onError: (error: Error) => void;
}

/**
 * The deletes of one queue's acknowledged bells, sent ten to a request. SQS bills a batch as one
 * request, so a worker that acks quickly pays about a tenth of the delete requests.
 *
 * A bell is deleted a few milliseconds after its ack, not before it returns, and a delete that fails
 * is counted and reported, never thrown at the handler. That loses nothing: a bell that is not deleted
 * comes back after its visibility timeout and claims nothing (the claim fence), and a worker that
 * closes sends what it holds first (`drain`). The delete of a bell that was already gone is not an error.
 */
export class DeleteBatcher {
  readonly #options: DeleteBatcherOptions;
  #handles: string[] = [];
  #timer: ReturnType<typeof setTimeout> | null = null;
  readonly #sending = new Set<Promise<void>>();

  constructor(options: DeleteBatcherOptions) {
    this.#options = options;
  }

  add(receiptHandle: string): void {
    this.#handles.push(receiptHandle);
    if (this.#handles.length >= MAX_DELETE_BATCH) this.#flush();
    else this.#timer ??= setTimeout(() => this.#flush(), DELETE_FLUSH_MS);
  }

  /** Sends what is held and waits for every delete in flight. */
  async drain(): Promise<void> {
    this.#flush();
    await Promise.all(this.#sending);
  }

  #flush(): void {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    if (this.#handles.length === 0) return;
    const sending = this.#send(this.#handles.splice(0));
    this.#sending.add(sending);
    void sending.finally(() => this.#sending.delete(sending));
  }

  /** Never rejects: a failure is a metric and one report per request. */
  async #send(handles: string[]): Promise<void> {
    const { client, urls, queueName, metrics, onError } = this.#options;
    metrics.deletes += 1;
    metrics.deletedBells += handles.length;
    try {
      const out = await client.send(
        new DeleteMessageBatchCommand({
          QueueUrl: await urls.url(queueName),
          Entries: handles.map((ReceiptHandle, index) => ({ Id: String(index), ReceiptHandle })),
        })
      );
      const failed = (out.Failed ?? []).filter((entry) => !isStaleCode(entry.Code));
      metrics.staleHandles += (out.Failed?.length ?? 0) - failed.length;
      if (failed.length === 0) return;
      metrics.deleteErrors += failed.length;
      onError(new Error(`DeleteMessageBatch: ${failed.length} failed: ${failed[0]?.Code}`));
    } catch (error) {
      if (isStaleHandle(error)) metrics.staleHandles += handles.length;
      else {
        metrics.deleteErrors += handles.length;
        onError(toError(error));
      }
    }
  }
}
