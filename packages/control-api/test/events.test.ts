import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { describeDb } from '../../../test/support/db';
import { DEFAULT_EVENT_RETENTION_MS } from '../../store-postgres/src/store/eventRetention';
import { claimOne } from '../../store-postgres/test/finishHelpers';
import { enqueueN } from '../../store-postgres/test/storeHelpers';
import type { JobsApi, JobsFixture } from './jobsFixture';
import { openJobsFixture } from './jobsFixture';
import type { Frame, FrameReader } from './sse';
import { connect, dataOf, openStream } from './sse';
import { DEV_TOKEN, errorOf, harness } from './support';

describeDb('GET /events', () => {
  let f: JobsFixture;
  let api: JobsApi;
  const readers: FrameReader[] = [];
  beforeAll(async () => {
    f = await openJobsFixture();
  });
  afterAll(() => f.drop());
  beforeEach(async () => {
    await f.reset();
    api = f.api({ summaryCacheMs: 0, events: { pollMs: 5, heartbeatMs: 1_000 } });
  });
  afterEach(async () => {
    await Promise.all(readers.splice(0).map((reader) => reader.cancel()));
  });

  /** Opens a stream and keeps the reader to hang up at the end of the test. */
  async function open(path = '/events', headers?: Record<string, string>) {
    const opened = await connect(api.api, path, headers === undefined ? {} : { headers });
    readers.push(opened.reader);
    return opened;
  }

  test('starts with a handshake: the stream headers, the retry delay and the position it begins at', async () => {
    const { reader, handshake } = await open();
    const { response } = reader;
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(response.headers.get('cache-control')).toContain('no-cache');
    expect(handshake.retry).toBe('2000');
    expect(JSON.parse(handshake.data!)).toEqual({ connected: true });
    const end = await f.store.events.baseline();
    expect(handshake.id).toBe(`${end.commitSeq}.${end.eventId}`);
  });

  test('sends what happens after it connected, one frame per journal event', async () => {
    await enqueueN(f.store, 2, {}, 'q');
    const { reader } = await open();
    const [id] = await enqueueN(f.store, 1, {}, 'q');
    const [pushed] = await reader.events(1);
    expect(pushed!.event).toBe('job:pushed');
    expect(dataOf(pushed!)).toMatchObject({
      queue: 'q',
      jobId: id,
      type: 'pushed',
      state: 'waiting',
    });
    expect(typeof dataOf(pushed!).timestamp).toBe('number');
    expect(pushed!.id).toMatch(/^\d+\.\d+$/);
  });

  test('follows a job through its life, with the error of a failure', async () => {
    const { reader } = await open();
    const job = await claimOne(f.t, { attempts: 1 }, 'q', 'w');
    await f.store.fail(job.lease, { message: 'it broke', unrecoverable: true });
    const frames = await reader.events(3);
    expect(frames.map((frame) => frame.event)).toEqual(['job:pushed', 'job:pulled', 'job:failed']);
    expect(dataOf(frames[2]!)).toMatchObject({ jobId: job.id, state: 'failed', error: 'it broke' });
    expect(new Set(frames.map((frame) => frame.id)).size).toBe(3);
  });

  test('obliterating a queue is a queue frame without a job id', async () => {
    await enqueueN(f.store, 1, {}, 'q');
    const { reader } = await open();
    expect((await api.call('POST', '/queues/q/obliterate', { confirm: 'q' })).status).toBe(200);
    // The jobs' own removals may come first.
    let frame: Frame | undefined;
    for (let seen = 0; seen < 10 && frame === undefined; seen += 1) {
      const [next] = await reader.events(1);
      if (next!.event === 'queue:obliterated') frame = next;
    }
    expect(frame).toBeDefined();
    expect(dataOf(frame!)).toMatchObject({ queue: 'q', type: 'obliterated' });
    expect(dataOf(frame!)).not.toHaveProperty('jobId');
  });

  test('a queue path or ?queue= keeps only that queue, and a queue that disagrees is 400', async () => {
    const byPath = await open('/events/queues/a');
    const byQuery = await open('/events?queue=a');
    await enqueueN(f.store, 1, {}, 'b');
    const [wanted] = await enqueueN(f.store, 1, {}, 'a');
    for (const { reader } of [byPath, byQuery]) {
      const [frame] = await reader.events(1);
      expect(dataOf(frame!)).toMatchObject({ queue: 'a', jobId: wanted });
    }
    const clash = await openStream(api.api, '/events/queues/a?queue=b');
    expect(clash.status).toBe(400);
  });

  test('?types= keeps only those types, with or without the job: prefix', async () => {
    const plain = await open('/events?types=completed');
    const prefixed = await open('/events?types=job:completed,job:failed');
    const job = await claimOne(f.t, {}, 'q', 'w');
    await f.store.complete(job.lease, 'done');
    for (const { reader } of [plain, prefixed]) {
      const [frame] = await reader.events(1);
      expect(frame!.event).toBe('job:completed');
      expect(dataOf(frame!).jobId).toBe(job.id);
    }
    const unknown = await openStream(api.api, '/events?types=exploded');
    expect(unknown.status).toBe(400);
    expect((await errorOf(unknown)).error.code).toBe('invalid_request');
  });

  test('resumes from Last-Event-ID, or ?cursor=, with the header winning', async () => {
    const first = await open();
    await enqueueN(f.store, 3, {}, 'q');
    const seen = await first.reader.events(3);
    const second = await open('/events', { 'last-event-id': seen[0]!.id! });
    const resumed = await second.reader.events(2);
    expect(resumed.map((frame) => frame.id)).toEqual([seen[1]!.id!, seen[2]!.id!]);
    expect(second.handshake.id).toBe(seen[0]!.id!);

    const byQuery = await open(`/events?cursor=${seen[1]!.id}`);
    expect((await byQuery.reader.events(1))[0]!.id).toBe(seen[2]!.id!);
    const both = await open(`/events?cursor=${seen[1]!.id}`, { 'last-event-id': seen[0]!.id! });
    expect((await both.reader.events(1))[0]!.id).toBe(seen[1]!.id!);
  });

  test('resume loses nothing and repeats nothing while writers commit concurrently', async () => {
    const start = await f.store.events.baseline();
    const first = await open();
    const writers = Array.from({ length: 40 }, async (_, index) => {
      const job = await claimOne(f.t, {}, `w${index}`, `worker-${index}`);
      await f.store.complete(job.lease, index);
    });
    // Hang up part way through, while commits are still landing.
    const early = await first.reader.events(15);
    await first.reader.cancel();
    await Promise.all(writers);

    const all = await f.store.events.read(start, { limit: 1_000 });
    expect(all.events.length).toBe(120);
    const last = early.at(-1)!.id!;
    const second = await open('/events', { 'last-event-id': last });
    const rest = await second.reader.events(all.events.length - early.length);

    const ids = [...early, ...rest].map((frame) => frame.id);
    expect(ids).toEqual(all.events.map((event) => `${event.commitSeq}.${event.id}`));
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('a position that is not ours is 400 invalid_cursor, in either place', async () => {
    for (const bad of ['abc', '1', '1.2.3', '-1.5', '1e3.4', '99999999999999999.1']) {
      const header = await openStream(api.api, '/events', { headers: { 'last-event-id': bad } });
      expect(header.status, bad).toBe(400);
      expect((await errorOf(header)).error.code, bad).toBe('invalid_cursor');
      const query = await openStream(api.api, `/events?cursor=${encodeURIComponent(bad)}`);
      expect(query.status, bad).toBe(400);
    }
  });

  test('a position past the end of the journal is 409 cursor_ahead', async () => {
    const end = await f.store.events.baseline();
    const ahead = `${end.commitSeq + 1000}.1`;
    const answer = await openStream(api.api, '/events', { headers: { 'last-event-id': ahead } });
    expect(answer.status).toBe(409);
    expect((await errorOf(answer)).error.code).toBe('cursor_ahead');
  });

  test('a client that fell behind pruned events is told to resync and then goes on', async () => {
    await enqueueN(f.store, 1, {}, 'q');
    f.t.clock.advance(DEFAULT_EVENT_RETENTION_MS + 1);
    const [fresh] = await enqueueN(f.store, 1, {}, 'q');
    expect((await f.store.events.trim()).removed).toBeGreaterThan(0);

    // `0.0` is a client that read nothing: the first event it never saw is gone.
    const { reader } = await open('/events', { 'last-event-id': '0.0' });
    const frames = await reader.events(2);
    expect(frames[0]!.event).toBe('resync');
    expect(dataOf(frames[0]!)).toEqual({ reason: 'events_pruned' });
    expect(dataOf(frames[1]!)).toMatchObject({ jobId: fresh });
  });

  test('a viewer can open a stream and a caller without credentials cannot', async () => {
    const none = await openStream(api.api, '/events', { token: null });
    expect(none.status).toBe(401);
    const viewer = harness(
      { devToken: { token: DEV_TOKEN, role: 'viewer' }, rateLimit: false },
      { jobs: { store: f.store, transport: f.transport, options: { summaryCacheMs: 0 } } },
      f.t.clock
    );
    const ok = await openStream(viewer, '/events');
    expect(ok.status).toBe(200);
    await ok.body!.cancel();
  });
});
