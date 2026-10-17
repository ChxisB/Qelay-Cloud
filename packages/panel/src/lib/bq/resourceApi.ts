import { getBaseUrl } from '@/components/dashboard/stores/connectionStore';
import type { CronFull } from '../bqTypes';
import {
  parseWebhookDeliveriesPayload,
  parseWebhooksPayload,
  parseWorkersPayload,
} from '../dashboardPayloads';
import {
  decodedHttpPathSegment,
  eventQueuePathSegment,
  opaqueHttpPathSegment,
} from '../upstreamPaths';
import { body, srv } from './transport';
import type { AddWebhookBody, CreateCronBody, WebhookDeliveriesQuery } from './types';

export const resourceApi = {
  crons: () => srv<{ ok: boolean; crons: CronFull[] }>('/crons'),
  createCron: (cron: CreateCronBody) => srv('/crons', body('POST', cron)),
  deleteCron: (name: string) =>
    srv(`/crons/${decodedHttpPathSegment(name, 'Cron name', 256)}`, { method: 'DELETE' }),
  webhooks: async () => parseWebhooksPayload(await srv<unknown>('/webhooks')),
  addWebhook: (webhook: AddWebhookBody) => srv('/webhooks', body('POST', webhook)),
  removeWebhook: (id: string) =>
    srv(`/webhooks/${opaqueHttpPathSegment(id)}`, { method: 'DELETE' }),
  setWebhookEnabled: (id: string, enabled: boolean) =>
    srv(`/webhooks/${opaqueHttpPathSegment(id)}/enabled`, body('PUT', { enabled })),
  webhookDeliveries: async (id: string, query: WebhookDeliveriesQuery = {}) => {
    const params = new URLSearchParams();
    if (query.limit !== undefined) params.set('limit', String(query.limit));
    if (query.before !== undefined) params.set('before', query.before);
    if (query.status !== undefined) params.set('status', query.status);
    const search = params.size > 0 ? `?${params.toString()}` : '';
    return parseWebhookDeliveriesPayload(
      await srv<unknown>(`/webhooks/${opaqueHttpPathSegment(id)}/deliveries${search}`)
    );
  },
  testWebhook: (id: string) => srv(`/webhooks/${opaqueHttpPathSegment(id)}/test`, body('POST')),
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
