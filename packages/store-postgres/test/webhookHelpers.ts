import type { WebhookEvent } from '@qelay-cloud/core';
import { WEBHOOK_EVENTS } from '@qelay-cloud/core';
import { createMsgpackCodec } from '../src/codec';
import type { StoreEvent } from '../src/store/events';
import { journalRecorder } from '../src/store/journal';
import type { WebhookRecord, WebhookSpec } from '../src/store/webhookTypes';
import type { TestStore } from './storeHelpers';
import { START } from './storeHelpers';

/** 32 bytes as 64 hex digits: the sealing key of every webhook test. */
export const KEY = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
export const SECRET = 'whsec_0123456789abcdef0123456789abcdef';

export const POLICY = { maxAttempts: 3, baseDelayMs: 1_000, maxDelayMs: 60_000 };

const recorder = journalRecorder({ namespace: 'test', codec: createMsgpackCodec() });

/** Registers a webhook for every event unless told otherwise. */
export function addHook(
  t: Pick<TestStore, 'store'>,
  spec: Partial<WebhookSpec> = {}
): Promise<WebhookRecord> {
  return t.store.webhooks.create(
    { url: 'https://hooks.example.com/in', events: [...WEBHOOK_EVENTS], ...spec },
    'tester'
  );
}

/** Writes journal events as an operation would, one transaction, at the clock's time. */
export async function journal(t: TestStore, events: readonly StoreEvent[]): Promise<void> {
  await t.fresh.sql.begin((tx) => recorder.record(tx, events, t.clock.now()));
}

export const event = (
  type: StoreEvent['type'],
  queue = 'q',
  jobId = 'j1',
  extra: Partial<StoreEvent> = {}
): StoreEvent => ({ type, queue, jobId, state: 'waiting', ...extra });

export interface RawDelivery {
  readonly id: string;
  readonly webhook_id: string;
  readonly event_name: string;
  readonly queue: string;
  readonly job_id: string;
  readonly status: string;
  readonly attempts: number;
  readonly attempt_base: number;
  readonly next_attempt_at: string | number;
  readonly event_id: string | null;
}

export async function rawDeliveries(t: TestStore): Promise<RawDelivery[]> {
  return t.fresh.sql<RawDelivery[]>`
    SELECT d.id::text AS id, d.webhook_id, d.event_name, d.queue, d.job_id, d.status, d.attempts,
           d.attempt_base, d.next_attempt_at, d.event_id::text AS event_id
    FROM qcloud_webhook_deliveries d ORDER BY d.id`;
}

export const names = async (t: TestStore): Promise<string[]> =>
  (await rawDeliveries(t)).map((row) => row.event_name);

export type { WebhookEvent };
export { START };

export const CLAIM = { limit: 50, leaseMs: 30_000, ratePerMinute: 1_000 };

/** A successful or failed result for a claimed delivery, as the sender would report it. */
export function outcome(
  claimed: { deliveryId: string; webhookId: string; attempt: number },
  result: { ok: boolean; statusCode?: number | null; error?: string | null; at?: number },
  durationMs = 12
): import('../src/store/webhookTypes').AttemptOutcome {
  return {
    deliveryId: claimed.deliveryId,
    webhookId: claimed.webhookId,
    attempt: claimed.attempt,
    ok: result.ok,
    statusCode: 'statusCode' in result ? result.statusCode! : result.ok ? 200 : 500,
    error: 'error' in result ? result.error! : result.ok ? null : 'receiver answered 500',
    startedAt: result.at ?? START,
    durationMs,
  };
}
