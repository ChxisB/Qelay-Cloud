/**
 * Load check of the event-gateway sender: how fast requests are accepted and how fast the sender drains the deliveries
 * they made, for a plain HTTP route, a batch route and a queue route, on local Postgres.
 *
 *   QCLOUD_REQUIRE_DB=1 bun scripts/sender-load.ts [--events 20000] [--latency 20]
 *
 * The receiver is scripted (it answers 200 after `--latency` ms), so the figures are the store's and the sender's own
 * cost plus that wait; a real receiver adds its own latency and the network. The sender is driven the way
 * `qcloud-tick send` drives it: `sendDueWebhooks` passes back to back until nothing is due. The per-webhook rate limit is
 * lifted for these runs (its default, 60 a minute, is the first ceiling a real route meets; see docs/production.md).
 * Honest limit: the receiver, the senders and the database share this machine, so the rates are a floor for separate hosts.
 */
import { runWebhookLoop } from '../packages/maintenance/src/webhookLoop';
import { sendDueWebhooks } from '../packages/maintenance/src/webhookSender';
import { resolveWebhookConfig } from '../packages/maintenance/src/webhookConfig';
import type { WebhookSenderOptions } from '../packages/maintenance/src/webhookConfig';
import { migrate, PostgresStore } from '../packages/store-postgres/src';
import { post } from '../packages/store-postgres/test/inboundHelpers';
import { freshSchema } from '../packages/store-postgres/test/helpers';
import { KEY } from '../packages/store-postgres/test/webhookHelpers';
import { sleep } from './load-lib';

const arg = (name: string, fallback: number): number => {
  const at = process.argv.indexOf(`--${name}`);
  const value = at < 0 ? fallback : Number(process.argv[at + 1]);
  if (!Number.isFinite(value) || value < 0) throw new Error(`--${name} is a number, 0 or more.`);
  return value;
};
const EVENTS = arg('events', 20_000);
const LATENCY = arg('latency', 20);
const APP = 'qcloud:sender-load';
const BODY = { id: 500, name: 'chris', plan: 'pro', items: [1, 2, 3] };

type Kind = 'http' | 'batch' | 'queue';
type Mode = 'pass' | 'loop';

const perSecond = (n: number, ms: number): string => `${Math.round((n * 1000) / ms).toLocaleString()}/s`;

/** `routes` routes of the given kind on a new source (each request makes one delivery per route), and the source's id. */
async function setup(store: PostgresStore, kind: Kind, routes: number): Promise<string> {
  const source = await store.sources.create({ name: 'Load' }, 'sender-load');
  const spec = { source: source.id };
  for (let n = 0; n < routes; n += 1) {
    if (kind === 'queue') {
      await store.webhooks.create({ ...spec, destination: 'queue', target: 'work' }, 'sender-load');
    } else {
      await store.webhooks.create(
        {
          ...spec,
          url: `https://hooks.example.com/in/${n}`,
          ...(kind === 'batch' ? { batch: { maxEvents: 100, maxBytes: 262_144 } } : {}),
        },
        'sender-load'
      );
    }
  }
  return source.id;
}

/** Accepts `count` requests, `width` at a time (the pool the ingest holds is 2; this is the store's own ceiling). */
async function accept(store: PostgresStore, source: string, count: number, width: number) {
  const started = performance.now();
  for (let sent = 0; sent < count; sent += width) {
    await Promise.all(
      Array.from({ length: Math.min(width, count - sent) }, async () => {
        const result = await store.sources.accept(source, post(BODY));
        if (result.outcome !== 'accepted') throw new Error(`not accepted: ${result.outcome}`);
      })
    );
  }
  return performance.now() - started;
}

/**
 * `senders` sender loops over one store until `expected` deliveries are delivered. `pass` runs `sendDueWebhooks` passes
 * (the tick's own sender, chunk by chunk); `loop` runs `runWebhookLoop` (`qcloud-tick send`, pipelined). A pass that finds
 * nothing due waits a moment and looks again: a claim holds a route's row, so another sender's claim sees nothing due
 * while it runs.
 */
async function drain(
  store: PostgresStore,
  options: WebhookSenderOptions,
  senders: number,
  expected: number,
  mode: Mode
) {
  const config = resolveWebhookConfig(
    { ratePerMinute: 1_000_000, ...options },
    { allowHttp: false, allowPrivate: false }
  )!;
  const errors: unknown[] = [];
  let requests = 0;
  let delivered = 0;
  const stop = new AbortController();
  const sending = {
    config,
    resolve: async () => ['93.184.216.34'],
    post: async () => {
      requests += 1;
      if (LATENCY > 0) await sleep(LATENCY);
      return { kind: 'status', status: 200 } as const;
    },
  };
  const telemetry = {
    duration: () => {},
    // The loop reports each recorded batch's deliveries as a gauge.
    gauge: (name: string, value: number) => {
      if (mode === 'loop' && name === 'webhooks.delivered') delivered += value;
    },
    error: (_step: string, error: unknown) => void errors.push(error),
  };
  const started = performance.now();
  await Promise.all(
    Array.from({ length: senders }, async () => {
      if (mode === 'loop') {
        const watch = setInterval(() => delivered >= expected && stop.abort(), 5);
        await runWebhookLoop(store, sending, telemetry, stop.signal);
        clearInterval(watch);
        return;
      }
      for (;;) {
        const result = await sendDueWebhooks(store, sending, telemetry);
        delivered += result.delivered;
        if (delivered >= expected) return;
        if (result.claimed === 0) await sleep(2);
      }
    })
  );
  if (errors.length > 0) throw new Error(`sender errors: ${String(errors[0])}`);
  return { ms: performance.now() - started, requests, delivered };
}

interface Row {
  readonly label: string;
  readonly kind: Kind;
  readonly senders: number;
  readonly routes?: number;
  readonly mode?: Mode;
  readonly options: WebhookSenderOptions;
}

async function run(row: Row): Promise<string> {
  const fresh = await freshSchema({ poolSize: 16, applicationName: APP });
  try {
    await migrate(fresh.db);
    const store = new PostgresStore({ db: fresh.db, namespace: 'load', webhookKey: KEY });
    const routes = row.routes ?? 1;
    const expected = EVENTS * routes;
    const source = await setup(store, row.kind, routes);
    const acceptMs = await accept(store, source, EVENTS, 8);
    const drained = await drain(store, row.options, row.senders, expected, row.mode ?? 'pass');
    const [left] = await fresh.sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM qcloud_deliveries WHERE status <> 'delivered'`;
    const [jobs] = await fresh.sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM qcloud_jobs WHERE queue = 'work'`;
    if (drained.delivered !== expected || (left?.n ?? 0) !== 0) {
      throw new Error(`${row.label}: delivered ${drained.delivered} of ${expected}, ${left?.n} not delivered`);
    }
    if (row.kind === 'queue' && jobs?.n !== expected) throw new Error(`${row.label}: ${jobs?.n} jobs`);
    return (
      `| ${row.label} | ${row.mode ?? 'pass'} | ${routes} | ${row.senders} | ${perSecond(EVENTS, acceptMs)} | ` +
      `${drained.requests.toLocaleString()} | ${perSecond(expected, drained.ms)} | ${perSecond(drained.requests, drained.ms)} |`
    );
  } finally {
    await fresh.drop();
  }
}

const BIG = { concurrency: 32, batch: 500 };
const rows: Row[] = [
  { label: 'http, defaults (concurrency 8, batch 50)', kind: 'http', senders: 1, options: {} },
  { label: 'http, concurrency 32, batch 500', kind: 'http', senders: 4, options: BIG },
  { label: 'http, defaults (concurrency 8)', kind: 'http', senders: 1, mode: 'loop', options: {} },
  { label: 'http, concurrency 32', kind: 'http', senders: 1, mode: 'loop', options: BIG },
  { label: 'http, concurrency 32', kind: 'http', senders: 4, mode: 'loop', options: BIG },
  { label: 'http, concurrency 32', kind: 'http', senders: 4, routes: 4, mode: 'loop', options: BIG },
  { label: 'batch of 100, defaults', kind: 'batch', senders: 1, options: {} },
  { label: 'batch of 100, defaults', kind: 'batch', senders: 1, mode: 'loop', options: {} },
  { label: 'queue route, defaults', kind: 'queue', senders: 1, options: {} },
  { label: 'queue route, concurrency 32', kind: 'queue', senders: 4, mode: 'loop', options: BIG },
];

console.log(`sender load: ${EVENTS.toLocaleString()} events per row, receiver latency ${LATENCY} ms, ${new Date().toISOString()}\n`);
console.log('| Route and settings | Sender | Routes | Senders | Accepted | Requests made | Deliveries delivered | Requests |');
console.log('| --- | --- | --- | --- | --- | --- | --- | --- |');
for (const row of rows) console.log(await run(row));
