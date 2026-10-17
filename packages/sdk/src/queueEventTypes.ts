import type { EventCursor, JournalEvent } from '@qelay-cloud/store-postgres';

/** The payloads of `QueueEvents`, under Qelay's names. Where the journal knows less, a field is left out. */
export interface WaitingEvent {
  readonly jobId: string;
}
export interface ActiveEvent {
  readonly jobId: string;
}
/** The journal records no return value: read it with `queue.getJob(jobId)`. */
export interface CompletedEvent {
  readonly jobId: string;
}
export interface FailedEvent {
  readonly jobId: string;
  readonly failedReason: string;
  /** False for a failed attempt that will be retried; true once the job failed for good. */
  readonly terminal: boolean;
}
export interface ProgressEvent {
  readonly jobId: string;
  /** The stored progress, 0 to 100. */
  readonly data: number;
}
export interface StalledEvent {
  readonly jobId: string;
}
export interface RemovedEvent {
  readonly jobId: string;
  /** The state the job was removed from. */
  readonly prev: string;
}
export interface DelayedEvent {
  readonly jobId: string;
}
export interface DuplicatedEvent {
  readonly jobId: string;
}
export interface WaitingChildrenEvent {
  readonly jobId: string;
}
export interface ObliteratedEvent {
  readonly queue: string;
}

/** The event names `QueueEvents` emits, with the payload of each; `error` and `gap` are listed apart. */
export interface QueueEventMap {
  waiting: WaitingEvent;
  active: ActiveEvent;
  completed: CompletedEvent;
  failed: FailedEvent;
  progress: ProgressEvent;
  stalled: StalledEvent;
  removed: RemovedEvent;
  delayed: DelayedEvent;
  duplicated: DuplicatedEvent;
  'waiting-children': WaitingChildrenEvent;
  obliterated: ObliteratedEvent;
}

export interface QueueEventListeners {
  waiting: (event: WaitingEvent) => void;
  active: (event: ActiveEvent) => void;
  completed: (event: CompletedEvent) => void;
  failed: (event: FailedEvent) => void;
  progress: (event: ProgressEvent) => void;
  stalled: (event: StalledEvent) => void;
  removed: (event: RemovedEvent) => void;
  delayed: (event: DelayedEvent) => void;
  duplicated: (event: DuplicatedEvent) => void;
  'waiting-children': (event: WaitingChildrenEvent) => void;
  obliterated: (event: ObliteratedEvent) => void;
  /** Events were deleted before this reader saw them: reload what you show from the jobs. */
  gap: () => void;
  error: (error: Error) => void;
}

export interface MappedEvent {
  readonly name: keyof QueueEventMap;
  readonly payload: QueueEventMap[keyof QueueEventMap];
}

/** What a job's entry into a claimable or waiting state is called: the journal's `state` says which. */
function entered(event: JournalEvent): MappedEvent {
  const { jobId } = event;
  if (event.state === 'delayed') return { name: 'delayed', payload: { jobId } };
  if (event.state === 'waiting-children') return { name: 'waiting-children', payload: { jobId } };
  return { name: 'waiting', payload: { jobId } };
}

/**
 * Journal event to Qelay's event, or null for one with no counterpart (`updated`, `priority`).
 * `retried` is a failed attempt with a retry pending; Qelay reports it as a non-terminal `failed`.
 */
export function mapJournalEvent(event: JournalEvent): MappedEvent | null {
  const { jobId } = event;
  switch (event.type) {
    case 'pushed':
    case 'promoted':
    case 'released':
      return entered(event);
    case 'duplicated':
      return { name: 'duplicated', payload: { jobId } };
    case 'pulled':
      return { name: 'active', payload: { jobId } };
    case 'completed':
      return { name: 'completed', payload: { jobId } };
    case 'retried':
    case 'failed':
      return {
        name: 'failed',
        payload: {
          jobId,
          failedReason: event.error ?? 'Job failed',
          terminal: event.type === 'failed',
        },
      };
    case 'stalled':
      return { name: 'stalled', payload: { jobId } };
    case 'progress':
      return { name: 'progress', payload: { jobId, data: event.progress ?? 0 } };
    case 'removed':
      return { name: 'removed', payload: { jobId, prev: event.state ?? 'unknown' } };
    case 'obliterated':
      return { name: 'obliterated', payload: { queue: event.queue } };
    default:
      return null;
  }
}

/** Where a `QueueEvents` starts reading. */
export type EventStart = 'now' | 'beginning' | EventCursor;
