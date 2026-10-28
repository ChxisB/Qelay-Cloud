import type { WebhookIssued, WebhookSpec } from '../src/store/webhookTypes';
import { post } from './inboundHelpers';
import type { TestStore } from './storeHelpers';
import { START } from './storeHelpers';

/** 32 bytes as 64 hex digits: the sealing key of every webhook test. */
export const KEY = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
export const SECRET = 'whsec_0123456789abcdef0123456789abcdef';

export const POLICY = { maxAttempts: 3, baseDelayMs: 1_000, maxDelayMs: 60_000 };

/** The one source the routes of `addHook` listen to; made on first use (tests reset the tables between cases). */
export async function hookSource(t: Pick<TestStore, 'store'>): Promise<string> {
  const found = (await t.store.sources.list()).find((source) => source.name === 'hooks');
  return found?.id ?? (await t.store.sources.create({ name: 'hooks' }, 'tester')).id;
}

/** Registers a route of the hooks source unless told otherwise. */
export async function addHook(
  t: Pick<TestStore, 'store'>,
  spec: Partial<WebhookSpec> = {}
): Promise<WebhookIssued> {
  return t.store.webhooks.create(
    { url: 'https://hooks.example.com/in', source: await hookSource(t), ...spec },
    'tester'
  );
}

/** One JSON request to the hooks source, as the ingest would hand it over: every route that passes makes a delivery. */
export async function send(
  t: Pick<TestStore, 'store'>,
  body: unknown = { n: 1 },
  extra: Parameters<typeof post>[1] = {}
): Promise<string> {
  const result = await t.store.sources.accept(await hookSource(t), post(body, extra));
  if (result.outcome !== 'accepted') throw new Error(`not accepted: ${result.outcome}`);
  return result.id;
}

/** `send` for each body in turn. */
export async function sendAll(
  t: Pick<TestStore, 'store'>,
  bodies: readonly unknown[]
): Promise<void> {
  for (const body of bodies) await send(t, body);
}

export interface RawDelivery {
  readonly id: string;
  readonly webhook_id: string;
  readonly event_name: string;
  readonly request_id: string | null;
  readonly status: string;
  readonly attempts: number;
  readonly attempt_base: number;
  readonly next_attempt_at: string | number;
}

export async function rawDeliveries(t: TestStore): Promise<RawDelivery[]> {
  return t.fresh.sql<RawDelivery[]>`
    SELECT d.id::text AS id, d.webhook_id, d.event_name, d.request_id::text AS request_id, d.status, d.attempts,
           d.attempt_base, d.next_attempt_at
    FROM qcloud_deliveries d ORDER BY d.id`;
}

export { START };

export const CLAIM = { limit: 50, leaseMs: 30_000, ratePerMinute: 1_000 };

/** A successful or failed result for a claimed delivery, as the sender would report it. */
export function outcome(
  claimed: { deliveryId: string; webhookId: string; attempt: number },
  result: {
    ok: boolean;
    statusCode?: number | null;
    error?: string | null;
    response?: string | null;
    at?: number;
  },
  durationMs = 12
): import('../src/store/webhookTypes').AttemptOutcome {
  return {
    deliveryId: claimed.deliveryId,
    webhookId: claimed.webhookId,
    attempt: claimed.attempt,
    ok: result.ok,
    statusCode: 'statusCode' in result ? result.statusCode! : result.ok ? 200 : 500,
    error: 'error' in result ? result.error! : result.ok ? null : 'receiver answered 500',
    ...(result.response === undefined ? {} : { response: result.response }),
    startedAt: result.at ?? START,
    durationMs,
  };
}
