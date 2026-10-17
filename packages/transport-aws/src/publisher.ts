import type { SQSClient } from '@aws-sdk/client-sqs';
import { SendMessageBatchCommand } from '@aws-sdk/client-sqs';
import type { RingItem, RingResult } from '@qelay-cloud/core';
import { encodeBell, MAX_MESSAGE_BYTES } from './bell';
import { isTransient } from './errors';
import type { SqsMetrics } from './metrics';
import { queueNames } from './names';
import type { QueueUrls } from './queueUrls';

/** SQS: at most 10 entries in one `SendMessageBatch`. */
export const MAX_RING_BATCH = 10;
/** SQS: `DelaySeconds` is at most 15 minutes. */
export const MAX_DELAY_SECONDS = 900;
const MAX_DELAY_MS = MAX_DELAY_SECONDS * 1_000;
/** Batches in flight at once for one `ring`: a 1,000-bell tick is 100 calls, not 100 in a row. */
const CONCURRENCY = 5;
const FIRST_BACKOFF_MS = 100;
const MAX_BACKOFF_MS = 1_000;

export interface PublisherOptions {
  readonly client: SQSClient;
  readonly urls: QueueUrls;
  readonly namespace: string;
  readonly metrics: SqsMetrics;
  /** How long one chunk keeps retrying a transient failure. */
  readonly budgetMs: number;
  /** Given the first error of a call that is not a per-entry refusal. */
  readonly onError: (error: unknown) => void;
  /** Tests substitute the clock, the wait and the jitter. */
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
}

interface Entry {
  readonly index: number;
  readonly body: string;
  readonly bytes: number;
  readonly delaySeconds: number;
}

/**
 * Rings every item and returns one result per item, in order. A failure becomes a result, never a
 * throw: the caller reports only the bells that were taken, and the tick rings the rest.
 *
 * - The delay is relative and rounded up to whole seconds: an early bell is an empty claim and a
 *   lost wake-up, a late one is only late. Above 900 s the item is `delay-too-long`, never clamped.
 * - Entries go in groups of 10 (and no more than 256 KiB) per queue. `SendMessageBatch` can answer
 *   200 with some entries in `Failed`: a refusal of the sender (`SenderFault`) is `rejected` and
 *   final, any other failure is tried again inside the budget and then is `unreachable`.
 * - A call that throws is tried again while the error is transient and the budget lasts; after that
 *   every entry of it is `unreachable`.
 */
export async function publishBells(
  options: PublisherOptions,
  items: readonly RingItem[]
): Promise<RingResult[]> {
  const results: RingResult[] = items.map(() => ({ ok: false, reason: 'unreachable' }));
  const byQueue = new Map<string, Entry[]>();
  const refuse = (index: number, reason: 'delay-too-long' | 'rejected') => {
    results[index] = { ok: false, reason };
  };
  items.forEach((item, index) => {
    const delayMs = Math.ceil(item.deliverAfterMs ?? 0);
    if (Number.isNaN(delayMs) || !Number.isFinite(delayMs)) return refuse(index, 'rejected');
    if (item.bell.namespace !== options.namespace) return refuse(index, 'rejected');
    if (delayMs > MAX_DELAY_MS) return refuse(index, 'delay-too-long');
    let queue: string;
    try {
      queue = queueNames(options.namespace, item.bell.queue).queue;
    } catch {
      // A queue name nothing could subscribe to.
      return refuse(index, 'rejected');
    }
    const body = encodeBell(item.bell);
    const bytes = Buffer.byteLength(body, 'utf8');
    if (bytes > MAX_MESSAGE_BYTES) return refuse(index, 'rejected');
    const entry: Entry = {
      index,
      body,
      bytes,
      delaySeconds: Math.ceil(Math.max(0, delayMs) / 1_000),
    };
    const list = byQueue.get(queue);
    if (list) list.push(entry);
    else byQueue.set(queue, [entry]);
  });

  const chunks: { queue: string; entries: Entry[] }[] = [];
  for (const [queue, entries] of byQueue) {
    for (const entriesOfCall of chunk(entries)) chunks.push({ queue, entries: entriesOfCall });
  }
  let firstError: unknown;
  const run = async (next: () => { queue: string; entries: Entry[] } | undefined) => {
    for (let work = next(); work; work = next()) {
      const error = await sendChunk(options, work.queue, work.entries, results);
      firstError ??= error;
    }
  };
  let at = 0;
  const next = () => chunks[at++];
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, chunks.length) }, () => run(next)));
  if (firstError !== undefined) options.onError(firstError);
  return results;
}

/** Groups of at most `MAX_RING_BATCH` entries whose bodies together fit one request. */
function chunk(entries: readonly Entry[]): Entry[][] {
  const groups: Entry[][] = [];
  let current: Entry[] = [];
  let bytes = 0;
  for (const entry of entries) {
    if (current.length === MAX_RING_BATCH || bytes + entry.bytes > MAX_MESSAGE_BYTES) {
      groups.push(current);
      current = [];
      bytes = 0;
    }
    current.push(entry);
    bytes += entry.bytes;
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

/** Sends one group, retrying what failed. Returns the first error it met, if any. */
async function sendChunk(
  options: PublisherOptions,
  queue: string,
  group: readonly Entry[],
  results: RingResult[]
): Promise<unknown> {
  const { client, urls, metrics } = options;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));
  const random = options.random ?? Math.random;
  const deadline = now() + Math.max(0, options.budgetMs);
  let pending = [...group];
  let backoff = FIRST_BACKOFF_MS;
  let firstError: unknown;
  for (let attempt = 0; pending.length > 0; attempt += 1) {
    let transient = true;
    try {
      const url = await urls.url(queue);
      metrics.sendCalls += 1;
      if (attempt > 0) metrics.sendRetries += 1;
      const out = await client.send(
        new SendMessageBatchCommand({
          QueueUrl: url,
          Entries: pending.map((entry, position) => ({
            Id: String(position),
            MessageBody: entry.body,
            ...(entry.delaySeconds > 0 ? { DelaySeconds: entry.delaySeconds } : {}),
          })),
        })
      );
      // The call can succeed while single entries fail: success is decided per entry. `Id` is the
      // position within this call; an entry named in neither list counts as failed.
      const taken = new Set((out.Successful ?? []).map((entry) => entry.Id));
      const refused = new Map<string, unknown>();
      for (const entry of out.Failed ?? []) {
        if (entry.Id !== undefined) refused.set(entry.Id, entry);
      }
      const retry: Entry[] = [];
      pending.forEach((entry, position) => {
        const id = String(position);
        const failed = refused.get(id) as { SenderFault?: boolean } | undefined;
        if (taken.has(id) && failed === undefined) {
          results[entry.index] = { ok: true };
          metrics.sentBells += 1;
        } else if (failed?.SenderFault === true) {
          results[entry.index] = { ok: false, reason: 'rejected' };
          metrics.failedEntries += 1;
          firstError ??= new Error(entryMessage(failed));
        } else {
          metrics.failedEntries += 1;
          firstError ??= new Error(entryMessage(failed));
          retry.push(entry);
        }
      });
      pending = retry;
    } catch (error) {
      metrics.failedEntries += pending.length;
      firstError ??= error;
      transient = isTransient(error);
    }
    if (pending.length === 0 || !transient) break;
    // Jitter inside [backoff / 2, backoff], so workers that failed together do not retry together.
    const wait = Math.round(backoff * (0.5 + random() / 2));
    if (now() + wait > deadline) break;
    await sleep(wait);
    backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
  }
  return firstError;
}

function entryMessage(entry: unknown): string {
  const { Code, Message } = (entry ?? {}) as { Code?: string; Message?: string };
  return `SendMessageBatch failed an entry: ${Code ?? 'no code'}${Message ? ` (${Message})` : ''}`;
}
