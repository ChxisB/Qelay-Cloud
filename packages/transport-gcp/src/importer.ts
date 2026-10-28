import type { SubscriberStub } from './deadLetters';

/** One message pulled from the subscription being imported. */
export interface ImportMessage {
  readonly ackId: string;
  /** Pub/Sub's own id: the same message has the same id every time it is delivered. */
  readonly messageId: string;
  readonly data: Uint8Array | string;
  readonly attributes: Readonly<Record<string, string>>;
}

/** What an import needs of the Pub/Sub API. The CLI builds the real one; a test passes its own. */
export interface ImportSource {
  /** Pulls up to `max` without acknowledging. Resolves empty when nothing is deliverable now. */
  pull(max: number): Promise<ImportMessage[]>;
  ack(ackIds: readonly string[]): Promise<void>;
  /** Makes the messages deliverable again now (an ack deadline of 0), instead of after the deadline. */
  release(ackIds: readonly string[]): Promise<void>;
}

export interface ImportJob {
  readonly name: string;
  readonly data: Readonly<Record<string, unknown>>;
  readonly opts: { readonly jobId: string };
}

/** Stores the jobs in one transaction or throws. Resolves with how many were new (the rest already existed). */
export type ImportSink = (jobs: readonly ImportJob[]) => Promise<{ readonly created: number }>;

export interface ImportOptions {
  /** The name every job gets: a Pub/Sub message has none. */
  readonly jobName: string;
  /** Count what is there and change nothing: no job is added, no message is acked. */
  readonly dryRun?: boolean;
  /** Stop after this many messages. Default: until the subscription is empty. */
  readonly max?: number;
  /** Messages per pull, and so per transaction. Default 100. */
  readonly page?: number;
  /** Empty pulls in a row that mean "empty". A pull can answer empty while messages remain. Default 2. */
  readonly emptyPulls?: number;
  /** Stops after the page in hand, so an operator's Ctrl-C leaves nothing half done. */
  readonly signal?: AbortSignal;
}

export interface ImportReport {
  /** Messages seen, counting a redelivery twice. */
  readonly pulled: number;
  /** Jobs that did not exist yet. A message pulled again after a crash adds none. */
  readonly created: number;
  readonly acked: number;
}

/**
 * The message as a job. The body is JSON when it parses and text otherwise (bytes are read as UTF-8);
 * the attributes are fields beside it, and an attribute named `body` loses to the body. The job id is
 * the message id, so a message delivered again while its job exists adds nothing.
 */
export function toImportJob(message: ImportMessage, name: string): ImportJob {
  const text =
    typeof message.data === 'string' ? message.data : Buffer.from(message.data).toString('utf8');
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // Not JSON: the text is the body.
  }
  return { name, data: { ...message.attributes, body }, opts: { jobId: message.messageId } };
}

/**
 * Moves a subscription's messages into a queue: pull a page, store it in one transaction, ack it.
 * The ack comes after the commit, so a crash between them (or a failed ack) delivers the page again
 * and the job ids dedupe it: at-least-once into Postgres, and no job twice. A page that fails to
 * store is handed back at once; one that is lost to a crash comes back when its ack deadline ends.
 * Nothing in a message body reaches an error or a report.
 */
// shortcut: a message delivered again after its job finished adds a new job (a finished job's id is taken over), so it runs twice; that needs a crash and a worker finishing the job inside one ack deadline. Pause the queue while importing when a second run is not safe.
export async function importSubscription(
  source: ImportSource,
  sink: ImportSink,
  options: ImportOptions
): Promise<ImportReport> {
  const page = options.page ?? 100;
  const limit = options.max ?? Number.POSITIVE_INFINITY;
  const emptyLimit = options.emptyPulls ?? 2;
  const held: string[] = [];
  let pulled = 0;
  let created = 0;
  let acked = 0;
  let empty = 0;
  try {
    while (pulled < limit && empty < emptyLimit && !options.signal?.aborted) {
      const messages = await source.pull(Math.min(page, limit - pulled));
      if (messages.length === 0) {
        empty += 1;
        continue;
      }
      empty = 0;
      pulled += messages.length;
      const ackIds = messages.map((message) => message.ackId);
      if (options.dryRun) {
        // Kept un-acked so the next pull moves on; all of them are given back at the end.
        held.push(...ackIds);
        continue;
      }
      try {
        // One job for each message id: the same message twice in a page cannot be added twice.
        const jobs = [
          ...new Map(messages.map((m) => [m.messageId, toImportJob(m, options.jobName)])).values(),
        ];
        created += (await sink(jobs)).created;
        await source.ack(ackIds);
        acked += ackIds.length;
      } catch (error) {
        await source.release(ackIds).catch(() => undefined);
        throw error;
      }
    }
  } finally {
    if (held.length > 0) await source.release(held).catch(() => undefined);
  }
  return { pulled, created, acked };
}

export interface AckingStub extends SubscriberStub {
  acknowledge(request: { subscription: string; ackIds: string[] }): Promise<unknown>;
}

/** gRPC "deadline exceeded": a pull on a subscription with nothing to deliver, which is an empty page. */
const DEADLINE_EXCEEDED = 4;

/** The source over the library's v1 subscriber client. `timeoutMs` bounds one pull. */
export function importSource(
  client: AckingStub,
  subscription: string,
  timeoutMs: number
): ImportSource {
  return {
    async pull(max) {
      let response;
      try {
        [response] = await client.pull({ subscription, maxMessages: max }, { timeout: timeoutMs });
      } catch (error) {
        if ((error as { code?: number }).code === DEADLINE_EXCEEDED) return [];
        throw error;
      }
      const messages: ImportMessage[] = [];
      for (const received of response.receivedMessages ?? []) {
        const message = received.message;
        if (!received.ackId || !message?.messageId) continue;
        messages.push({
          ackId: received.ackId,
          messageId: message.messageId,
          data: message.data ?? '',
          attributes: message.attributes ?? {},
        });
      }
      return messages;
    },
    async ack(ackIds) {
      if (ackIds.length > 0) await client.acknowledge({ subscription, ackIds: [...ackIds] });
    },
    async release(ackIds) {
      if (ackIds.length === 0) return;
      await client.modifyAckDeadline({ subscription, ackIds: [...ackIds], ackDeadlineSeconds: 0 });
    },
  };
}
