import { getBaseUrl } from '@/components/dashboard/stores/connectionStore';
import type { CronFull } from '../bqTypes';
import {
  parseWebhookDeliveriesPayload,
  parseWebhooksPayload,
  parseWorkersPayload,
} from '../dashboardPayloads';
import {
  parseDestinationPayload,
  parseDestinationsPayload,
  parseWebhookGroupStatsPayload,
  parseWebhookIssuePayload,
  parseWebhookIssuesPayload,
} from '../gatewayFeedPayloads';
import { parseWebhookStatsPayload } from '../gatewayPayloads';
import {
  decodedHttpPathSegment,
  eventQueuePathSegment,
  opaqueHttpPathSegment,
} from '../upstreamPaths';
import type {
  AddDestinationBody,
  DestinationPatchBody,
  WebhookGroupStatsQuery,
  WebhookIssuesQuery,
  WebhookIssueStatus,
  WebhookPatchBody,
  WebhookPauseMode,
} from './gatewayTypes';
import { body, srv } from './transport';
import type {
  AddWebhookBody,
  AllWebhookDeliveriesQuery,
  CreateCronBody,
  WebhookDeliveriesQuery,
  WebhookStatsQuery,
} from './types';

const search = (query: object): string => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value));
  }
  return params.size > 0 ? `?${params.toString()}` : '';
};

export const resourceApi = {
  crons: () => srv<{ ok: boolean; crons: CronFull[] }>('/crons'),
  createCron: (cron: CreateCronBody) => srv('/crons', body('POST', cron)),
  deleteCron: (name: string) =>
    srv(`/crons/${decodedHttpPathSegment(name, 'Cron name', 256)}`, { method: 'DELETE' }),
  webhooks: async () => parseWebhooksPayload(await srv<unknown>('/webhooks')),
  addWebhook: (webhook: AddWebhookBody) => srv('/webhooks', body('POST', webhook)),
  removeWebhook: (id: string) =>
    srv(`/webhooks/${opaqueHttpPathSegment(id)}`, { method: 'DELETE' }),
  /** The keys present are set and `null` clears all but `events`. */
  updateWebhook: (id: string, patch: WebhookPatchBody) =>
    srv(`/webhooks/${opaqueHttpPathSegment(id)}`, body('PATCH', patch)),
  /** Off without a mode is the server's default: `ignore`. `hold` keeps collecting events for later. */
  setWebhookEnabled: (id: string, enabled: boolean, mode?: WebhookPauseMode) =>
    srv(
      `/webhooks/${opaqueHttpPathSegment(id)}/enabled`,
      body('PUT', mode === undefined ? { enabled } : { enabled, mode })
    ),
  webhookIssues: async (query: WebhookIssuesQuery = {}) =>
    parseWebhookIssuesPayload(await srv<unknown>(`/webhooks/issues${search(query)}`)),
  setWebhookIssueStatus: async (id: string, status: WebhookIssueStatus) =>
    parseWebhookIssuePayload(
      await srv<unknown>(`/webhooks/issues/${opaqueHttpPathSegment(id)}`, body('PUT', { status }))
    ),
  /** One entry per route, for the connections list. */
  webhookGroupStats: async (query: WebhookGroupStatsQuery) =>
    parseWebhookGroupStatsPayload(
      await srv<unknown>(`/webhooks/stats${search({ groupBy: 'webhook', ...query })}`)
    ),
  destinations: async () => parseDestinationsPayload(await srv<unknown>('/webhooks/destinations')),
  addDestination: async (destination: AddDestinationBody) =>
    parseDestinationPayload(
      await srv<unknown>('/webhooks/destinations', body('POST', destination))
    ),
  updateDestination: async (id: string, patch: DestinationPatchBody) =>
    parseDestinationPayload(
      await srv<unknown>(
        `/webhooks/destinations/${opaqueHttpPathSegment(id)}`,
        body('PATCH', patch)
      )
    ),
  removeDestination: (id: string) =>
    srv(`/webhooks/destinations/${opaqueHttpPathSegment(id)}`, { method: 'DELETE' }),
  webhookDeliveries: async (id: string, query: WebhookDeliveriesQuery = {}) =>
    parseWebhookDeliveriesPayload(
      await srv<unknown>(`/webhooks/${opaqueHttpPathSegment(id)}/deliveries${search(query)}`)
    ),
  /** The Events screen: every route's deliveries, newest first. */
  webhookEvents: async (query: AllWebhookDeliveriesQuery = {}) =>
    parseWebhookDeliveriesPayload(await srv<unknown>(`/webhooks/deliveries${search(query)}`)),
  webhookStats: async (query: WebhookStatsQuery) =>
    parseWebhookStatsPayload(await srv<unknown>(`/webhooks/stats${search(query)}`)),
  /** Puts a route's failed deliveries back to be sent again, newest first. */
  retryFailedWebhookDeliveries: (id: string, options: { before?: string; limit?: number } = {}) =>
    srv<{ ok: boolean; data?: { retried?: number } }>(
      `/webhooks/${opaqueHttpPathSegment(id)}/deliveries/retry`,
      body('POST', { status: 'failed', ...options })
    ),
  testWebhook: (id: string) => srv(`/webhooks/${opaqueHttpPathSegment(id)}/test`, body('POST')),
  /** No body: the server generates the secret and returns it once, as `data.secret`. */
  rotateWebhookSecret: (id: string) =>
    srv(`/webhooks/${opaqueHttpPathSegment(id)}/rotate-secret`, body('POST')),
  retryWebhookDelivery: (id: string, deliveryId: string) =>
    srv(
      `/webhooks/${opaqueHttpPathSegment(id)}/deliveries/${opaqueHttpPathSegment(deliveryId)}/retry`,
      body('POST')
    ),
  workers: async () => parseWorkersPayload(await srv<unknown>('/workers')),
  unregisterWorker: (id: string) =>
    srv(`/workers/${opaqueHttpPathSegment(id)}`, { method: 'DELETE' }),
  eventsUrl: (queue?: string) =>
    getBaseUrl() + (queue ? `/events/queues/${eventQueuePathSegment(queue)}` : '/events'),
};
