/**
 * Routes (DESIGN.md D14): a webhook is a route from an inbound source to a destination. A `queue` route adds a job
 * to a queue of the namespace. A job makes no request, so no route can feed another and none can loop.
 */

export const WEBHOOK_DESTINATIONS = ['http', 'queue'] as const;
export type WebhookDestination = (typeof WEBHOOK_DESTINATIONS)[number];

export const isWebhookDestination = (value: unknown): value is WebhookDestination =>
  typeof value === 'string' && (WEBHOOK_DESTINATIONS as readonly string[]).includes(value);

/** Most saved destinations a namespace keeps (the same cap as webhooks). */
export const MAX_DESTINATIONS = 100;

/**
 * The id of the job a `queue` route's delivery adds. It is made from the delivery id, so a repeated
 * attempt finds that job and adds no second one, and a reader can name the job from the delivery.
 * A job's id is up to 256 characters; a delivery id is a number, so this always fits.
 */
export const routeJobId = (deliveryId: string): string => `qcloud-route-${deliveryId}`;
