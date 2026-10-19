import type {
  AttemptRecord,
  DeliveredEvent,
  DeliveryStatus,
  WebhookEvent,
  WebhookFilter,
  WebhookShape,
} from '@qelay-cloud/core';
import {
  UnsupportedOptionError,
  WEBHOOK_ERROR_CHARS,
  WEBHOOK_RESPONSE_CHARS,
  WEBHOOK_HISTORY_ENTRIES,
} from '@qelay-cloud/core';
import type { DeliveryRecord, WebhookRecord } from './webhookTypes';

type Time = number | string | bigint;

export interface WebhookRow {
  readonly id: string;
  readonly url: string;
  readonly events: string[];
  readonly queue: string | null;
  readonly secret_sealed: string | null;
  readonly enabled: boolean;
  readonly filter: unknown;
  readonly shape: unknown;
  readonly created_by: string;
  readonly created_at: Time;
  readonly success_count: Time;
  readonly failure_count: Time;
  readonly last_triggered: Time | null;
  readonly consecutive_failures: number;
  readonly alert_level: number;
  readonly disabled_reason: string | null;
  readonly disabled_at: Time | null;
  readonly secret_previous_until: Time | null;
}

export interface DeliveryRow {
  readonly id: Time;
  readonly webhook_id: string;
  readonly event_name: string;
  readonly queue: string;
  readonly job_id: string;
  readonly occurred_at: Time;
  readonly status: string;
  readonly attempts: number;
  readonly next_attempt_at: Time;
  readonly last_status_code: number | null;
  readonly last_error: string | null;
  readonly history: unknown;
  readonly created_at: Time;
  readonly finished_at: Time | null;
}

export const WEBHOOK_COLUMNS = `id, url, events, queue, secret_sealed, enabled, filter, shape, created_by,
  created_at, success_count, failure_count, last_triggered, consecutive_failures, alert_level,
  disabled_reason, disabled_at, secret_previous_until`;

export const DELIVERY_COLUMNS = `id, webhook_id, event_name, queue, job_id, occurred_at, status, attempts,
  next_attempt_at, last_status_code, last_error, history, created_at, finished_at`;

const orNull = (value: Time | null): number | null => (value === null ? null : Number(value));

/** A JSONB column as the driver hands it back: parsed, or text when the driver leaves JSONB alone. */
export const jsonOrNull = <T>(value: unknown): T | null =>
  value === null || value === undefined
    ? null
    : ((typeof value === 'string' ? JSON.parse(value) : value) as T);

export const webhookOf = (row: WebhookRow): WebhookRecord => ({
  id: row.id,
  url: row.url,
  events: row.events as WebhookEvent[],
  queue: row.queue,
  signed: row.secret_sealed !== null,
  enabled: row.enabled,
  filter: jsonOrNull<WebhookFilter>(row.filter),
  shape: jsonOrNull<WebhookShape>(row.shape),
  createdBy: row.created_by,
  createdAt: Number(row.created_at),
  lastTriggered: orNull(row.last_triggered),
  successCount: Number(row.success_count),
  failureCount: Number(row.failure_count),
  consecutiveFailures: row.consecutive_failures,
  alertLevel: row.alert_level,
  disabledReason: row.disabled_reason,
  disabledAt: orNull(row.disabled_at),
  previousSecretUntil: orNull(row.secret_previous_until),
});

/** The history column as the driver hands it back: parsed, or text when the driver leaves JSONB alone. */
export function historyOf(value: unknown): AttemptRecord[] {
  const parsed = typeof value === 'string' ? (JSON.parse(value) as unknown) : value;
  return Array.isArray(parsed) ? (parsed as AttemptRecord[]) : [];
}

export const deliveryOf = (row: DeliveryRow): DeliveryRecord => ({
  id: String(row.id),
  webhookId: row.webhook_id,
  event: row.event_name as DeliveredEvent,
  queue: row.queue,
  jobId: row.job_id,
  occurredAt: Number(row.occurred_at),
  status: row.status as DeliveryStatus,
  attempts: row.attempts,
  nextAttemptAt: Number(row.next_attempt_at),
  lastStatusCode: row.last_status_code,
  lastError: row.last_error,
  history: historyOf(row.history),
  createdAt: Number(row.created_at),
  finishedAt: orNull(row.finished_at),
});

/** Cuts an error to what the delivery keeps. NUL is dropped: a text column refuses it. */
export function boundedError(text: string): string {
  const clean = text.includes('\0') ? text.replaceAll('\0', '') : text;
  return clean.length <= WEBHOOK_ERROR_CHARS
    ? clean
    : `${clean.slice(0, WEBHOOK_ERROR_CHARS - 1)}…`;
}

/** What a failed attempt's history keeps of the answer's body: null for none, else at most `WEBHOOK_RESPONSE_CHARS`. */
export function boundedResponse(text: string | null | undefined): string | null {
  const clean = (text ?? '').replaceAll('\0', '');
  if (clean === '') return null;
  return clean.length <= WEBHOOK_RESPONSE_CHARS
    ? clean
    : `${clean.slice(0, WEBHOOK_RESPONSE_CHARS - 1)}…`;
}

/** The history with `entry` appended, keeping the newest `WEBHOOK_HISTORY_ENTRIES`. */
export function appendHistory(
  history: readonly AttemptRecord[],
  entry: AttemptRecord
): AttemptRecord[] {
  return [...history, entry].slice(-WEBHOOK_HISTORY_ENTRIES);
}

/** A delivery id from a caller, as the number it stands for; anything else is refused by name. */
export function deliveryNumber(name: string, value: string): number {
  if (!/^[1-9]\d{0,15}$/u.test(value)) {
    throw new UnsupportedOptionError(name, 'must be a delivery id');
  }
  return Number(value);
}
