import { afterAll, afterEach, beforeAll, beforeEach, expect, spyOn, test } from 'bun:test';
import { describeDb } from '../../../test/support/db';
import { enqueueN } from '../../store-postgres/test/storeHelpers';
import type { JobsFixture } from './jobsFixture';
import { openJobsFixture } from './jobsFixture';
import type { FrameReader } from './sse';
import { connect, eventually, openStream } from './sse';
import type { Harness } from './support';
import { errorOf } from './support';

describeDb('GET /events bounds', () => {
  let f: JobsFixture;
  let app: Harness;
  const readers: FrameReader[] = [];
  beforeAll(async () => {
    f = await openJobsFixture();
  });
  afterAll(() => f.drop());
  beforeEach(async () => {
    await f.reset();
  });
  afterEach(async () => {
    await Promise.all(readers.splice(0).map((reader) => reader.cancel()));
  });

  /** A Control API whose streams are bounded as given; `pollMs` is short so a test does not wait. */
  const build = (events: Record<string, number> = {}): void => {
    app = f.api({ summaryCacheMs: 0, events: { pollMs: 5, heartbeatMs: 100, ...events } }).api;
  };

  async function open(path = '/events') {
    const opened = await connect(app, path);
    readers.push(opened.reader);
    return opened;
  }

  /** True when the principal can open one more stream (and does not keep it). */
  async function hasRoom(): Promise<boolean> {
    const response = await openStream(app, '/events');
    await response.body?.cancel();
    return response.status === 200;
  }

  test('an idle stream sends a keep-alive comment once the heartbeat has passed', async () => {
    build({ heartbeatMs: 100 });
    const { reader } = await open();
    let arrived = false;
    const heartbeat = reader.comment().then((text) => {
      arrived = true;
      return text;
    });
    f.t.clock.advance(99);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(arrived).toBe(false);
    f.t.clock.advance(1);
    expect(await heartbeat).toBe('keep-alive');
  });

  test('a stream ends cleanly at its maximum lifetime and gives its place back', async () => {
    build({ maxLifetimeMs: 1_000, heartbeatMs: 5_000, maxPerPrincipal: 1 });
    const { reader } = await connect(app, '/events');
    expect(await hasRoom()).toBe(false);
    f.t.clock.advance(1_000);
    const frames = await reader.rest();
    expect(frames.map((frame) => frame.comment)).toEqual([
      'maximum lifetime reached: reconnect with Last-Event-ID',
    ]);
    expect(await hasRoom()).toBe(true);
  });

  test('a principal over its cap is 429 with Retry-After, and closing one makes room', async () => {
    build({ maxPerPrincipal: 2 });
    const first = await open();
    await open();
    const over = await openStream(app, '/events');
    expect(over.status).toBe(429);
    expect(over.headers.get('retry-after')).toBe('5');
    const body = await errorOf(over);
    expect(body.error.code).toBe('too_many_streams');
    expect(body.error.details).toEqual({ max: 2 });
    await first.reader.cancel();
    expect(await hasRoom()).toBe(true);
  });

  test('an instance with no room is 503 for everyone', async () => {
    build({ maxPerPrincipal: 5, maxStreams: 2 });
    await open();
    await open();
    const full = await openStream(app, '/events');
    expect(full.status).toBe(503);
    expect((await errorOf(full)).error.code).toBe('streams_unavailable');
  });

  test('a refused cursor or type does not take a place', async () => {
    build({ maxPerPrincipal: 1 });
    expect((await openStream(app, '/events?types=nope')).status).toBe(400);
    expect((await openStream(app, '/events', { headers: { 'last-event-id': 'x' } })).status).toBe(
      400
    );
    expect(
      (await openStream(app, '/events', { headers: { 'last-event-id': '9999.1' } })).status
    ).toBe(409);
    expect(await hasRoom()).toBe(true);
  });

  test('a client that goes away gives its place back', async () => {
    build({ maxPerPrincipal: 1 });
    const hangUp = new AbortController();
    const { reader } = await connect(app, '/events', { signal: hangUp.signal });
    readers.push(reader);
    expect(await hasRoom()).toBe(false);
    hangUp.abort();
    expect(await hasRoom()).toBe(true);
  });

  test('a request that is already aborted is not served and holds nothing', async () => {
    build({ maxPerPrincipal: 1 });
    const gone = new AbortController();
    gone.abort();
    const response = await openStream(app, '/events', { signal: gone.signal });
    expect(response.status).toBe(499);
    expect(await hasRoom()).toBe(true);
  });

  test('a client that does not read is dropped, and the journal is not read ahead of it', async () => {
    build({ bufferBytes: 200, slowClientMs: 40, pageSize: 5, maxPerPrincipal: 1 });
    const real = f.store.events.read.bind(f.store.events);
    let returned = 0;
    const spy = spyOn(f.store.events, 'read').mockImplementation(async (...args) => {
      const page = await real(...args);
      returned += page.events.length;
      return page;
    });
    try {
      const { reader } = await open();
      await enqueueN(f.store, 100, {}, 'q');
      // Nobody reads. The stream stops pulling when its queue is full, then drops the client.
      await eventually(() => returned >= 5);
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(returned).toBeLessThanOrEqual(5);
      await expect(reader.next()).rejects.toThrow('the client is not reading');
      expect(app.recorded.warnings.map((warning) => warning.message)).toContain(
        'event stream dropped: the client is not reading'
      );
      expect(await hasRoom()).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  test('a client that reads steadily is never dropped for being slow', async () => {
    build({ bufferBytes: 200, slowClientMs: 40, pageSize: 5 });
    const { reader } = await open();
    await enqueueN(f.store, 30, {}, 'q');
    const frames = await reader.events(30, 5_000);
    expect(new Set(frames.map((frame) => frame.id)).size).toBe(30);
  });

  test('when the journal cannot be read the stream closes cleanly and the client may retry', async () => {
    build({ maxPerPrincipal: 1 });
    const spy = spyOn(f.store.events, 'read').mockRejectedValue(new Error('connection reset'));
    try {
      const { reader } = await connect(app, '/events');
      const frames = await reader.rest();
      expect(frames.map((frame) => frame.comment)).toEqual([
        'the event journal is unavailable: reconnect',
      ]);
    } finally {
      spy.mockRestore();
    }
    expect(await hasRoom()).toBe(true);
    expect(app.recorded.warnings.map((warning) => warning.message)).toContain(
      'event stream ended: the journal could not be read'
    );
  });

  test('a store that is down when the stream opens is an error response and not a stream', async () => {
    build();
    const spy = spyOn(f.store.events, 'baseline').mockRejectedValue(new Error('down'));
    try {
      const response = await openStream(app, '/events');
      expect(response.status).toBeGreaterThanOrEqual(500);
      expect(response.headers.get('content-type')).not.toContain('text/event-stream');
    } finally {
      spy.mockRestore();
    }
  });
});
