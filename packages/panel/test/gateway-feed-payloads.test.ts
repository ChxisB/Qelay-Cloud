import { describe, expect, test } from 'bun:test';
import { parseWebhooksPayload } from '../src/lib/dashboardPayloads';
import {
  parseDestinationPayload,
  parseDestinationsPayload,
  parseWebhookGroupStatsPayload,
  parseWebhookIssuePayload,
  parseWebhookIssuesPayload,
} from '../src/lib/gatewayFeedPayloads';

const issue = (over: Record<string, unknown> = {}) => ({
  id: 'i1',
  webhookId: 'h1',
  webhookName: 'Orders to billing',
  status: 'open',
  kind: 'delivery_failed',
  openedAt: 1_000,
  updatedAt: 2_000,
  updatedBy: null,
  consecutiveFailures: 3,
  alertLevel: 1,
  pausedBy: null,
  ...over,
});
const counts = { open: 1, acknowledged: 0, resolved: 2, ignored: 0 };
const issues = (list: unknown[] = [issue()], over: Record<string, unknown> = {}) => ({
  ok: true,
  data: { issues: list, next: null, counts, ...over },
});

describe('webhook issues payload', () => {
  test('accepts a page, a cursor and a route that has no name', () => {
    const page = parseWebhookIssuesPayload(
      issues([issue(), issue({ id: 'i2', webhookName: null, pausedBy: 'failures' })], { next: '9' })
    );
    expect(page.issues).toHaveLength(2);
    expect(page.next).toBe('9');
    expect(page.counts.resolved).toBe(2);
    expect(parseWebhookIssuesPayload(issues([])).issues).toEqual([]);
  });

  test.each([
    ['an unknown status', issues([issue({ status: 'snoozed' })])],
    ['an unknown kind', issues([issue({ kind: 'slow' })])],
    ['an alert level over 4', issues([issue({ alertLevel: 5 })])],
    ['a pausedBy that is not one of the two', issues([issue({ pausedBy: 'someone' })])],
    ['a repeated id', issues([issue(), issue()])],
    ['a count that is missing', issues([], { counts: { open: 1, acknowledged: 0, resolved: 0 } })],
    ['a negative count', issues([], { counts: { ...counts, open: -1 } })],
    ['a count of a status that does not exist', issues([], { counts: { ...counts, lost: 1 } })],
    ['a cursor that is not text', issues([], { next: 4 })],
    ['more than 200 issues', issues(Array.from({ length: 201 }, (_, n) => issue({ id: `i${n}` })))],
    ['no envelope', { ok: true }],
    ['an ok that is false', { ok: false, data: issues().data }],
  ])('refuses %s', (_label, payload) => {
    expect(() => parseWebhookIssuesPayload(payload)).toThrow('Malformed webhook issues response.');
  });

  test('a changed issue is checked as one', () => {
    expect(parseWebhookIssuePayload({ ok: true, data: { issue: issue() } }).id).toBe('i1');
    expect(() =>
      parseWebhookIssuePayload({ ok: true, data: { issue: issue({ id: '' }) } })
    ).toThrow('Malformed webhook issue response.');
    expect(() => parseWebhookIssuePayload({ ok: true, data: {} })).toThrow(/Malformed/);
  });
});

const bucket = (over: Record<string, unknown> = {}) => ({
  from: 0,
  delivered: 3,
  failed: 1,
  pending: 0,
  ...over,
});
const group = (over: Record<string, unknown> = {}) => ({
  webhookId: 'h1',
  delivered: 3,
  failed: 1,
  pending: 0,
  failureRatio: 0.25,
  backlog: 0,
  oldestPendingAt: null,
  buckets: [bucket()],
  ...over,
});
const grouped = (groups: unknown[] = [group()], over: Record<string, unknown> = {}) => ({
  ok: true,
  data: { since: 0, until: 3_600_000, bucketMs: 3_600_000, groups, ...over },
});

describe('webhook group stats payload', () => {
  test('accepts a route with traffic and one with none', () => {
    const stats = parseWebhookGroupStatsPayload(
      grouped([group(), group({ webhookId: 'h2', failureRatio: null, buckets: [] })])
    );
    expect(stats.groups.map((g) => g.webhookId)).toEqual(['h1', 'h2']);
    expect(parseWebhookGroupStatsPayload(grouped([])).groups).toEqual([]);
  });

  test.each([
    ['a count that is not whole', grouped([group({ delivered: 1.5 })])],
    ['a failure ratio over 1', grouped([group({ failureRatio: 1.5 })])],
    ['a failure ratio that is text', grouped([group({ failureRatio: 'high' })])],
    ['an oldestPendingAt that is not a time', grouped([group({ oldestPendingAt: 'soon' })])],
    [
      'a bucket without its time',
      grouped([group({ buckets: [{ delivered: 1, failed: 0, pending: 0 }] })]),
    ],
    [
      'more than 168 buckets',
      grouped([group({ buckets: Array.from({ length: 169 }, (_, n) => bucket({ from: n })) })]),
    ],
    ['a route listed twice', grouped([group(), group()])],
    ['a window that is not a time', grouped([], { since: 'then' })],
    ['no envelope', { ok: true }],
  ])('refuses %s', (_label, payload) => {
    expect(() => parseWebhookGroupStatsPayload(payload)).toThrow(
      'Malformed webhook group stats response.'
    );
  });
});

const destination = (over: Record<string, unknown> = {}) => ({
  id: 'd1',
  name: 'Billing',
  kind: 'http',
  url: 'https://billing.example.com/in',
  urlRedacted: false,
  target: null,
  connections: 2,
  createdAt: 1,
  updatedAt: 2,
  ...over,
});
const queueDestination = (over: Record<string, unknown> = {}) =>
  destination({ id: 'd2', name: 'Orders', kind: 'queue', url: '', target: 'orders', ...over });

describe('destinations payload', () => {
  test('accepts an http destination and a queue one, and the answer to a save', () => {
    const list = parseDestinationsPayload({
      ok: true,
      data: { destinations: [destination(), queueDestination()] },
    });
    expect(list.map((d) => d.kind)).toEqual(['http', 'queue']);
    expect(list[1]).toMatchObject({ url: '', target: 'orders' });
    expect(parseDestinationPayload({ ok: true, data: { destination: destination() } }).name).toBe(
      'Billing'
    );
  });

  test('accepts the origin a read-only caller gets', () => {
    const [seen] = parseDestinationsPayload({
      ok: true,
      data: {
        destinations: [destination({ url: 'https://billing.example.com/', urlRedacted: true })],
      },
    });
    expect(seen!.urlRedacted).toBe(true);
  });

  test.each([
    ['an unknown kind', destination({ kind: 'ftp' })],
    ['an http destination with a target', destination({ target: 'orders' })],
    ['an http destination that is not an address', destination({ url: 'not a url' })],
    [
      'an http destination with an address that is not http',
      destination({ url: 'ftp://x.example.com/' }),
    ],
    ['a queue destination without a target', queueDestination({ target: null })],
    ['a queue destination with an address', queueDestination({ url: 'https://x.example.com/' })],
    ['a name that is empty', destination({ name: '' })],
    ['a connection count that is negative', destination({ connections: -1 })],
    ['an urlRedacted that is not a boolean', destination({ urlRedacted: 'yes' })],
    ['a time that is not a time', destination({ createdAt: 'then' })],
  ])('refuses %s', (_label, one) => {
    expect(() => parseDestinationsPayload({ ok: true, data: { destinations: [one] } })).toThrow(
      'Malformed destinations response.'
    );
    expect(() => parseDestinationPayload({ ok: true, data: { destination: one } })).toThrow(
      'Malformed destination response.'
    );
  });

  test('refuses a repeated id, a list that is not a list and no envelope', () => {
    expect(() =>
      parseDestinationsPayload({ ok: true, data: { destinations: [destination(), destination()] } })
    ).toThrow(/Malformed/);
    expect(() => parseDestinationsPayload({ ok: true, data: { destinations: {} } })).toThrow(
      /Malformed/
    );
    expect(() => parseDestinationsPayload({ ok: true })).toThrow(/Malformed/);
  });
});

describe('fields a gateway route adds to the webhook registry', () => {
  const hook = {
    id: 'h',
    url: 'https://receiver.test/',
    urlRedacted: false,
    source: 'src_1',
    signed: false,
    enabled: true,
    createdAt: 1,
    lastTriggered: null,
    successCount: 0,
    failureCount: 0,
  };
  const parse = (over: Record<string, unknown>) =>
    parseWebhooksPayload({ ok: true, data: { webhooks: [{ ...hook, ...over }] } }).data
      .webhooks[0]!;

  test('a server before the gateway sends none of them, and they read as unset', () => {
    expect(parse({})).toMatchObject({
      name: null,
      description: null,
      delayMs: null,
      dedupe: null,
      pausedBy: null,
      destinationId: null,
    });
  });

  test('an older server paused only for failing, so an off route with a reason was that', () => {
    expect(
      parse({ enabled: false, disabledReason: '10 failed deliveries in a row' }).pausedBy
    ).toBe('failures');
    expect(parse({ enabled: false }).pausedBy).toBeNull();
    expect(
      parse({ enabled: false, pausedBy: 'operator', disabledReason: 'paused by an operator' })
        .pausedBy
    ).toBe('operator');
  });

  test('keeps a name, a multi-line description, a delay, a dedupe and a destination', () => {
    expect(
      parse({
        name: 'Orders to billing',
        description: 'Line one\nLine two',
        delayMs: 5_000,
        dedupe: { windowMs: 60_000, fields: ['body.id', 'method'] },
        destinationId: 'd1',
      })
    ).toMatchObject({
      name: 'Orders to billing',
      description: 'Line one\nLine two',
      delayMs: 5_000,
      dedupe: { windowMs: 60_000, fields: ['body.id', 'method'] },
      destinationId: 'd1',
    });
  });

  test.each([
    ['an empty name', { name: '' }],
    ['a name that is not text', { name: 7 }],
    ['a description with a control character', { description: 'a\u0000b' }],
    ['a delay that is not a count', { delayMs: -1 }],
    ['a dedupe without a window', { dedupe: { fields: ['event'] } }],
    ['a dedupe without fields', { dedupe: { windowMs: 1_000, fields: [] } }],
    ['a pausedBy that is not known', { pausedBy: 'nobody' }],
    ['a destinationId that is not text', { destinationId: 3 }],
  ])('refuses %s', (_label, over) => {
    expect(() => parse(over)).toThrow(/Malformed/);
  });
});
