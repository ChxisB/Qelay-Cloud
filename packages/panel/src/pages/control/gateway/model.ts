import type { WebhookDeliveryFull, WebhookDeliveryStatus, WebhookPauseMode } from '@/lib/bq';
import type { WebhookFull } from '@/lib/bqTypes';
import { displayWebhookUrl } from '../webhooks/model';

/** What a route reads from: its inbound source, by id (the Sources page names them). */
export const sourceLabel = (route: WebhookFull): string =>
  route.source ? `Source: ${route.source}` : 'No source';

/** What a delivery was made from: the request it came in as, or a test. */
export const requestLabel = (delivery: WebhookDeliveryFull): string =>
  delivery.requestId ? `Request ${delivery.requestId}` : 'Test delivery';

export const destinationLabel = (route: WebhookFull): string =>
  route.destination === 'queue' ? `Queue: ${route.target}` : displayWebhookUrl(route.url);

/** What a connection is called: its name, or where it sends when it has none. */
export const routeName = (route: WebhookFull): string => route.name ?? destinationLabel(route);

/** The line under a destination: what it does with an event. */
export const destinationSub = (route: WebhookFull): string =>
  route.destination === 'queue'
    ? 'adds a job'
    : `${route.signed ? 'signed' : 'unsigned'}${route.urlRedacted ? ' · path hidden' : ''}`;

/** `source → destination`, led by the name when the connection has one. */
export const routeLine = (route: WebhookFull): string =>
  `${route.name ? `${route.name}: ` : ''}${sourceLabel(route)} → ${destinationLabel(route)}`;

/**
 * `held` is an operator's Pause: off, and events are still collected. `paused` is the store's automatic pause
 * after repeated failures: off, collecting too. `off` is Disable: off, and events are ignored.
 */
export type RouteState = 'active' | 'held' | 'paused' | 'off';

/** `mode` is how a switch in flight turns the route off; it stands in for `pausedBy` until the server answers. */
export function routeState(
  route: WebhookFull,
  enabled = route.enabled,
  mode?: WebhookPauseMode
): RouteState {
  if (enabled) return 'active';
  if (mode) return mode === 'hold' ? 'held' : 'off';
  return route.pausedBy === 'operator' ? 'held' : route.pausedBy === 'failures' ? 'paused' : 'off';
}

export const STATE_WORDS: Record<RouteState, string> = {
  active: 'Active',
  held: 'Paused',
  paused: 'Paused after failures',
  off: 'Disabled',
};

/** The rules a connection carries, as chips. Retry and auto-pause are on for every route, so they say nothing here. */
export function ruleChips(route: WebhookFull): string[] {
  const chips: string[] = [];
  if (route.filter) chips.push('Filter');
  if (route.shape) chips.push('Reshaped');
  if (route.delayMs) chips.push('Delay');
  if (route.dedupe) chips.push('Deduplicated');
  if (route.schedule) chips.push('Scheduled');
  if (route.batch) chips.push('Batched');
  if (route.destination === 'http' && route.signed) chips.push('Signed');
  return chips;
}

export const STATE_FILTERS: ReadonlyArray<{ value: RouteState | 'all'; label: string }> = [
  { value: 'all', label: 'Any state' },
  { value: 'active', label: STATE_WORDS.active },
  { value: 'held', label: STATE_WORDS.held },
  { value: 'paused', label: STATE_WORDS.paused },
  { value: 'off', label: STATE_WORDS.off },
];

/** Connections whose id, name, queues or shown destination contain the text, and whose state is the one asked for. */
export function filterRoutes(
  routes: readonly WebhookFull[],
  filter: { text: string; state: string }
): WebhookFull[] {
  const needle = filter.text.trim().toLowerCase();
  return routes.filter(
    (route) =>
      (filter.state === 'all' || routeState(route) === filter.state) &&
      (needle === '' ||
        [route.id, route.name, route.source, route.target, destinationLabel(route)].some(
          (value) => typeof value === 'string' && value.toLowerCase().includes(needle)
        ))
  );
}

/** Where a connection is made. Not an id, so it cannot be taken for one: the router ranks it first. */
export const NEW_CONNECTION = '/events-gateway/connections/new';

/** The page of one connection; its tabs are `/metrics` and `/settings` under it. */
export const connectionLink = (id: string): string =>
  `/events-gateway/connections/${encodeURIComponent(id)}`;

/** The routes under one source heading, in the order the registry gave them. */
export function groupBySource(routes: readonly WebhookFull[]): Array<[string, WebhookFull[]]> {
  const groups = new Map<string, WebhookFull[]>();
  for (const route of routes) {
    const key = sourceLabel(route);
    groups.set(key, [...(groups.get(key) ?? []), route]);
  }
  return [...groups];
}

/** The Events screen's status chips: one per status the API filters by (`sending` is an attempt in flight). */
export const EVENT_CHIPS: ReadonlyArray<{ value: WebhookDeliveryStatus | 'all'; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'pending', label: 'Pending' },
  { value: 'sending', label: 'Sending' },
  { value: 'delivered', label: 'Successful' },
  { value: 'failed', label: 'Failed' },
];

export const EVENT_WORDS: Record<WebhookDeliveryStatus, string> = {
  pending: 'Pending',
  sending: 'Sending',
  delivered: 'Successful',
  failed: 'Failed',
};

/** A pending event of a route that is not sending is held, not waiting its turn. */
export const isOnHold = (delivery: WebhookDeliveryFull, route: WebhookFull | undefined): boolean =>
  delivery.status === 'pending' && route !== undefined && !route.enabled;

/** The Events screen's time ranges; the Metrics screen takes the same ones. */
export const RANGES = [
  { value: '1h', label: 'Last hour', ms: 3_600_000 },
  { value: '6h', label: 'Last 6 hours', ms: 6 * 3_600_000 },
  { value: '24h', label: 'Last 24 hours', ms: 24 * 3_600_000 },
  { value: '7d', label: 'Last 7 days', ms: 7 * 24 * 3_600_000 },
] as const;

export type RangeValue = (typeof RANGES)[number]['value'];

export const rangeMs = (value: string | null, fallback: RangeValue): number =>
  (RANGES.find((range) => range.value === value) ?? RANGES.find((r) => r.value === fallback)!).ms;

/** `#1 500 · #2 503 · #3 200`: what each attempt got back, oldest first. */
export function attemptSummary(delivery: WebhookDeliveryFull): string {
  return delivery.history
    .map((entry) => `#${entry.attempt} ${entry.statusCode ?? 'no answer'}`)
    .join(' · ');
}

/** The events page a Metrics card or an issue opens: the same filter, so the numbers can be checked. */
export function eventsLink(filter: { route?: string; status?: string; range?: string }): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filter)) if (value) params.set(key, value);
  const query = params.toString();
  return `/events-gateway/events${query ? `?${query}` : ''}`;
}

/** The two filters the feed cannot do: they apply to the page that is loaded, not to the whole history. */
export function matchesEvent(
  delivery: WebhookDeliveryFull,
  filter: { code: string; text: string }
): boolean {
  const code = filter.code.trim();
  if (code && !delivery.history.some((entry) => String(entry.statusCode ?? '').startsWith(code))) {
    return false;
  }
  const text = filter.text.trim().toLowerCase();
  if (!text) return true;
  return [delivery.requestId, delivery.event, delivery.routedJobId, delivery.lastError]
    .filter((value): value is string => typeof value === 'string')
    .some((value) => value.toLowerCase().includes(text));
}

/** How far `consecutiveFailures` has come toward the automatic pause, by `alertLevel` 0 to 4. */
const ALERT_PERCENT = [0, 50, 70, 90, 100] as const;

export interface RouteIssue {
  route: WebhookFull;
  kind: 'paused' | 'failing';
  title: string;
  detail: string;
}

/**
 * What needs a person, from each connection's own failure count: paused ones first, then those heading
 * for a pause. There is no acknowledge or resolve state: an issue goes away when the connection recovers.
 */
export function routeIssues(routes: readonly WebhookFull[]): RouteIssue[] {
  const issues: RouteIssue[] = [];
  for (const route of routes) {
    if (route.pausedBy === 'failures') {
      issues.push({
        route,
        kind: 'paused',
        title: 'Paused after failures',
        detail: route.disabledReason ?? 'It failed too often.',
      });
    } else if (route.enabled && route.alertLevel > 0) {
      const percent = ALERT_PERCENT[Math.min(route.alertLevel, 4)];
      issues.push({
        route,
        kind: 'failing',
        title: `${route.consecutiveFailures} events failed in a row`,
        detail: `${percent}% of the way to being paused.`,
      });
    }
  }
  const rank = (issue: RouteIssue) => (issue.kind === 'paused' ? 5 : issue.route.alertLevel);
  return issues.sort((a, b) => rank(b) - rank(a));
}
