import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import {
  DEFAULT_DELIVERY_POLICY,
  DEFAULT_REPLAY_TOLERANCE_MS,
  MAX_FILTER_DEPTH,
  MAX_FILTER_LIST,
  MAX_FILTER_NODES,
  MAX_FILTER_STRING,
  MAX_REF_CHARS,
  MAX_SHAPE_BYTES,
  MAX_SHAPE_DEPTH,
  MAX_SHAPE_NODES,
  MAX_SHAPED_BODY_BYTES,
  MAX_WEBHOOK_URL_CHARS,
  MAX_WEBHOOKS,
  signWebhook,
  WEBHOOK_EVENTS,
  WEBHOOK_HEADERS,
  WEBHOOK_HISTORY_ENTRIES,
  webhookRetryDelayMs,
} from '../../packages/core/src';
import {
  DEFAULT_WEBHOOK_BATCH,
  DEFAULT_WEBHOOK_BREAKER_COOLDOWN_MS,
  DEFAULT_WEBHOOK_BREAKER_FAILURES,
  DEFAULT_WEBHOOK_BUDGET_MS,
  DEFAULT_WEBHOOK_CONCURRENCY,
  DEFAULT_WEBHOOK_DNS_TTL_MS,
  DEFAULT_WEBHOOK_IDLE_MS,
  DEFAULT_WEBHOOK_KEEPALIVE_MS,
  DEFAULT_WEBHOOK_LEASE_MS,
  DEFAULT_WEBHOOK_PER_DESTINATION,
  DEFAULT_WEBHOOK_RATE_PER_MINUTE,
  DEFAULT_WEBHOOK_TIMEOUT_MS,
} from '../../packages/maintenance/src';
import { MAX_SECRET_CHARS, MIN_SECRET_CHARS } from '../../packages/store-postgres/src';

/**
 * docs/webhooks.md is what a receiver's author copies from, so its example is run and its numbers
 * are compared with the code that sets them.
 */
const doc = await Bun.file(resolve(import.meta.dir, '../../docs/webhooks.md')).text();

type Verify = (secret: string, headers: Headers, body: string, now?: number) => Promise<boolean>;

/** The doc's TypeScript block, compiled and loaded as a module of its own. */
async function documentedVerifier(): Promise<Verify> {
  const match = /```ts\n([\s\S]*?)\n```/u.exec(doc);
  expect(match).not.toBeNull();
  const js = new Bun.Transpiler({ loader: 'ts' }).transformSync(match![1]!);
  const source = `${js}\nexport { verify };`;
  const loaded = (await import(
    `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
  )) as { verify: Verify };
  return loaded.verify;
}

const SECRET = 'a-shared-secret-of-16+';
const BODY = '{"id":"7","event":"job.failed","timestamp":1,"queue":"q","jobId":"j"}';
const NOW = 1_800_000_000_000;

async function request(over: { body?: string; at?: number; signature?: string } = {}) {
  const sent = String(over.at ?? NOW);
  return new Headers({
    [WEBHOOK_HEADERS.timestamp]: sent,
    [WEBHOOK_HEADERS.signature]: over.signature ?? (await signWebhook(SECRET, sent, BODY)),
  });
}

describe('docs/webhooks.md: the receiver example', async () => {
  const verify = await documentedVerifier();

  test('accepts what the sender signs', async () => {
    expect(await verify(SECRET, await request(), BODY, NOW)).toBe(true);
    expect(await verify(SECRET, await request(), BODY, NOW + 300_000)).toBe(true);
  });

  test('refuses a changed body, a wrong secret, a stale timestamp and a malformed signature', async () => {
    expect(await verify(SECRET, await request(), `${BODY} `, NOW)).toBe(false);
    expect(await verify('another-secret-16-chars', await request(), BODY, NOW)).toBe(false);
    expect(await verify(SECRET, await request(), BODY, NOW + 300_001)).toBe(false);
    expect(await verify(SECRET, await request(), BODY, NOW - 300_001)).toBe(false);
    for (const signature of ['', 'v1=', 'v1=zz', 'v1=abc', 'v1=00'.repeat(32)]) {
      expect(await verify(SECRET, await request({ signature }), BODY, NOW)).toBe(false);
    }
    // A fresh timestamp on a captured signature does not verify: the timestamp is signed.
    const captured = await signWebhook(SECRET, String(NOW), BODY);
    expect(
      await verify(SECRET, await request({ at: NOW + 1_000, signature: captured }), BODY, NOW)
    ).toBe(false);
  });
});

describe('docs/webhooks.md: its figures are the code', () => {
  test('the replay window, retry schedule and attempt budget', () => {
    expect(DEFAULT_REPLAY_TOLERANCE_MS).toBe(300_000);
    expect(doc).toContain('more than **300 seconds**');
    const waits = Array.from({ length: DEFAULT_DELIVERY_POLICY.maxAttempts - 1 }, (_, i) =>
      webhookRetryDelayMs(i + 1, DEFAULT_DELIVERY_POLICY)
    );
    expect(waits.map((ms) => ms / 1_000)).toEqual([30, 60, 120, 240, 480, 960, 1_920]);
    expect(waits.reduce((a, b) => a + b, 0) / 60_000).toBe(63.5);
    expect(doc).toContain(
      '30 s, 1 m, 2 m, 4 m, 8 m, 16 m and 32 m, up to **8 attempts** (63.5 minutes'
    );
  });

  test('the sender defaults in the configuration table', () => {
    const row = (name: string) => doc.split('\n').find((line) => line.startsWith(`| \`${name}\``));
    const defaultOf = (name: string) => {
      const cells = row(name)!
        .split('|')
        .map((cell) => cell.trim());
      return cells[cells.length - 2];
    };
    const figure = (n: number) => n.toLocaleString('en-US');
    expect(defaultOf('QCLOUD_WEBHOOK_BATCH')).toBe(figure(DEFAULT_WEBHOOK_BATCH));
    expect(defaultOf('QCLOUD_WEBHOOK_CONCURRENCY')).toBe(figure(DEFAULT_WEBHOOK_CONCURRENCY));
    expect(defaultOf('QCLOUD_WEBHOOK_BUDGET_MS')).toBe(figure(DEFAULT_WEBHOOK_BUDGET_MS));
    expect(defaultOf('QCLOUD_WEBHOOK_TIMEOUT_MS')).toBe(figure(DEFAULT_WEBHOOK_TIMEOUT_MS));
    expect(defaultOf('QCLOUD_WEBHOOK_LEASE_MS')).toBe(figure(DEFAULT_WEBHOOK_LEASE_MS));
    expect(defaultOf('QCLOUD_WEBHOOK_RATE_PER_MINUTE')).toBe(
      figure(DEFAULT_WEBHOOK_RATE_PER_MINUTE)
    );
    expect(defaultOf('QCLOUD_WEBHOOK_KEEPALIVE_MS')).toBe(figure(DEFAULT_WEBHOOK_KEEPALIVE_MS));
    expect(defaultOf('QCLOUD_WEBHOOK_DNS_TTL_MS')).toBe(figure(DEFAULT_WEBHOOK_DNS_TTL_MS));
    expect(defaultOf('QCLOUD_WEBHOOK_PER_DESTINATION')).toBe(
      figure(DEFAULT_WEBHOOK_PER_DESTINATION)
    );
    expect(defaultOf('QCLOUD_WEBHOOK_BREAKER_FAILURES')).toBe(
      figure(DEFAULT_WEBHOOK_BREAKER_FAILURES)
    );
    expect(defaultOf('QCLOUD_WEBHOOK_BREAKER_COOLDOWN_MS')).toBe(
      figure(DEFAULT_WEBHOOK_BREAKER_COOLDOWN_MS)
    );
    expect(defaultOf('QCLOUD_WEBHOOK_IDLE_MS')).toBe(figure(DEFAULT_WEBHOOK_IDLE_MS));
    const { maxAttempts, baseDelayMs, maxDelayMs } = DEFAULT_DELIVERY_POLICY;
    expect(defaultOf('QCLOUD_WEBHOOK_MAX_ATTEMPTS`, `_BASE_DELAY_MS`, `_MAX_DELAY_MS')).toBe(
      `${maxAttempts}, ${figure(baseDelayMs)}, ${figure(maxDelayMs)}`
    );
  });

  test('sizes, events and headers', () => {
    expect(doc).toContain(`at most ${MAX_WEBHOOK_URL_CHARS.toLocaleString('en-US')} characters`);
    expect(doc).toContain(`At most **${MAX_WEBHOOKS}** webhooks`);
    expect(doc).toContain(`${MIN_SECRET_CHARS} to ${MAX_SECRET_CHARS} characters`);
    expect(doc).toContain(`**last ${WEBHOOK_HISTORY_ENTRIES} attempts**`);
    for (const event of WEBHOOK_EVENTS) expect(doc).toContain(`\`${event}\``);
    for (const header of Object.values(WEBHOOK_HEADERS)) expect(doc).toContain(`\`${header}\``);
  });
});

describe('docs/webhooks.md: the filter and shape limits are the code', () => {
  test('sizes', () => {
    const flat = doc.replace(/\s+/g, ' ');
    expect(flat).toContain(
      `At most ${MAX_FILTER_NODES} terms, ${MAX_FILTER_DEPTH} levels deep, ${MAX_FILTER_LIST} values per list, ${MAX_FILTER_STRING} characters per text`
    );
    expect(flat).toContain(
      `At most ${MAX_SHAPE_NODES} values, ${MAX_SHAPE_DEPTH} levels deep, ${MAX_SHAPE_BYTES / 1024} KiB for the template`
    );
    expect(flat).toContain(`cut to ${MAX_REF_CHARS} characters`);
    expect(flat).toContain(`body past ${MAX_SHAPED_BODY_BYTES / 1024} KiB`);
    expect(flat).toContain(`larger than ${MAX_SHAPED_BODY_BYTES} bytes`);
  });
});
