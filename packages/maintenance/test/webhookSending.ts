import { WEBHOOK_HEADERS } from '@qelay-cloud/core';
import type { TestStore } from '../../store-postgres/test/storeHelpers';
import type { WebhookSenderOptions } from '../src/webhookConfig';
import { resolveWebhookConfig } from '../src/webhookConfig';
import type { PostRequest, PostResult } from '../src/webhookHttp';
import type { RecordingTransport, recordedTelemetry } from './support';
import { ticker } from './support';

export const STRICT = { allowHttp: false, allowPrivate: false };
export const PUBLIC = '93.184.216.34';

/** What a scripted receiver saw: one entry per request, in order. */
export interface Seen {
  readonly deliveryId: string;
  readonly attempt: number;
  readonly request: PostRequest;
}

export const status = (code: number): PostResult => ({ kind: 'status', status: code });

/** The scripted-receiver ticker the sender suites share. `t` and `transport` are read when called, as the suites open them in `beforeAll`. */
export function senderHarness(t: () => TestStore, transport: () => RecordingTransport) {
  const options = (overrides: WebhookSenderOptions = {}): WebhookSenderOptions => ({
    maxAttempts: 3,
    baseDelayMs: 1_000,
    maxDelayMs: 60_000,
    ratePerMinute: 100_000,
    ...overrides,
  });

  /** A ticker that sends through a receiver answering from `answer(call number)`. */
  function sending(
    answer: (call: number, seen: Seen) => PostResult | Promise<PostResult>,
    overrides: WebhookSenderOptions = {},
    store = t().store,
    telemetry?: ReturnType<typeof recordedTelemetry>
  ) {
    const seen: Seen[] = [];
    const config = resolveWebhookConfig(options(overrides), STRICT)!;
    const run = ticker(store, transport(), { intervalMs: 5_000 }, telemetry, {
      config,
      resolve: async () => [PUBLIC],
      now: () => t().clock.now(),
      post: async (request) => {
        const entry: Seen = {
          deliveryId: request.headers[WEBHOOK_HEADERS.id]!,
          attempt: Number(request.headers[WEBHOOK_HEADERS.attempt]),
          request,
        };
        seen.push(entry);
        return answer(seen.length, entry);
      },
    });
    return { ...run, seen };
  }
  return { sending };
}
