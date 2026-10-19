/**
 * What the transport asked of SQS, counted per request type. SQS bills per request, so these are the
 * basis of the cost arithmetic (`billedRequests`, `docs/limits.md`); they also say how a run went.
 */
export interface SqsMetrics {
  /** `SendMessageBatch` calls, retries included. */
  sendCalls: number;
  /** Bells SQS took. */
  sentBells: number;
  /** Entries of a `SendMessageBatch` that came back in `Failed`, and every entry of a call that threw. */
  failedEntries: number;
  /** Calls made again after a transient failure. */
  sendRetries: number;
  receiveCalls: number;
  emptyReceives: number;
  receiveErrors: number;
  received: number;
  largestReceive: number;
  /** `DeleteMessageBatch` calls (up to ten bells each). */
  deletes: number;
  /** Bells whose delete was sent, whether or not it succeeded. */
  deletedBells: number;
  /** Bells whose delete failed for another reason than a handle that was no longer valid. */
  deleteErrors: number;
  /** `ChangeMessageVisibility` calls that extended a bell still being claimed. */
  heartbeats: number;
  /** `ChangeMessageVisibility` calls that returned a bell (a nack). */
  nacks: number;
  /** A delete or a visibility change whose receipt handle was stale: harmless, only counted. */
  staleHandles: number;
  /** A visibility change that failed for another reason. */
  visibilityErrors: number;
  /** `GetQueueUrl` calls: one per queue, then cached. */
  queueUrlLookups: number;
}

export function newMetrics(): SqsMetrics {
  return {
    sendCalls: 0,
    sentBells: 0,
    failedEntries: 0,
    sendRetries: 0,
    receiveCalls: 0,
    emptyReceives: 0,
    receiveErrors: 0,
    received: 0,
    largestReceive: 0,
    deletes: 0,
    deletedBells: 0,
    deleteErrors: 0,
    heartbeats: 0,
    nacks: 0,
    staleHandles: 0,
    visibilityErrors: 0,
    queueUrlLookups: 0,
  };
}

/** The requests SQS bills for one run: every call of the table above that reached the service. */
export function billedRequests(metrics: Readonly<SqsMetrics>): number {
  return (
    metrics.sendCalls +
    metrics.receiveCalls +
    metrics.deletes +
    metrics.heartbeats +
    metrics.nacks +
    metrics.queueUrlLookups
  );
}
