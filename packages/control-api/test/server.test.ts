import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { RunningServer } from '../src';
import { startControlApi } from '../src';
import { DEV_TOKEN, harness, testRoutes } from './support';

let server: RunningServer;
const origin = 'https://panel.example.com';

beforeAll(() => {
  const { app } = harness({ maxBodyBytes: 1_000, corsOrigins: [origin] });
  server = startControlApi(app, { port: 0 });
});
afterAll(() => server.stop());

const call = (path: string, init: RequestInit = {}, token: string | null = DEV_TOKEN) =>
  fetch(new URL(path, server.url), {
    ...init,
    headers: { ...(token === null ? {} : { authorization: `Bearer ${token}` }), ...init.headers },
  });

test('serves requests over a real socket: public health, authenticated routes, JSON errors', async () => {
  expect((await call('/health', {}, null)).status).toBe(200);
  expect((await call('/test/read', {}, null)).status).toBe(401);
  const ok = await call('/test/read');
  expect(ok.status).toBe(200);
  expect(await ok.json()).toEqual({ ok: true });
  const missing = await call('/test/missing');
  expect(missing.status).toBe(404);
  expect(((await missing.json()) as { error: { code: string } }).error.code).toBe('not_found');
});

test('a write with a JSON body works end to end', async () => {
  const response = await call('/test/write', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'wire' }),
  });
  expect(await response.json()).toEqual({ name: 'wire' });
});

test('a body over the cap is refused with 413 whatever its framing', async () => {
  const big = JSON.stringify({ name: 'x'.repeat(5_000) });
  const sized = await call('/test/write', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: big,
  });
  expect(sized.status).toBe(413);
  const chunked = await call('/test/write', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(big));
        controller.close();
      },
    }),
    duplex: 'half',
  } as RequestInit);
  expect(chunked.status).toBe(413);
});

test('a CORS preflight from the listed origin works without a token', async () => {
  const response = await call(
    '/test/write',
    { method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'POST' } },
    null
  );
  expect(response.status).toBe(204);
  expect(response.headers.get('access-control-allow-origin')).toBe(origin);
});

test('the server reports the port it listens on, and stops', async () => {
  const { app } = harness();
  const other = startControlApi(app, { port: 0 });
  expect(other.port).toBeGreaterThan(0);
  expect((await fetch(new URL('/health', other.url))).status).toBe(200);
  await other.stop();
  await expect(fetch(new URL('/health', other.url))).rejects.toThrow();
});

test('stop(true) closes an open event stream instead of waiting for it', async () => {
  const stream = {
    method: 'GET',
    path: '/test/stream',
    access: 'read',
    handle: () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start: (controller) => controller.enqueue(new TextEncoder().encode('data: hello\n\n')),
        }),
        { headers: { 'content-type': 'text/event-stream' } }
      ),
  } as const;
  const { app } = harness({}, { routes: testRoutes([stream]) });
  const other = startControlApi(app, { port: 0 });
  const response = await fetch(new URL('/test/stream', other.url), {
    headers: { authorization: `Bearer ${DEV_TOKEN}` },
  });
  const reader = response.body!.getReader();
  expect((await reader.read()).done).toBe(false);

  const stopped = await Promise.race([
    other.stop(true).then(() => 'stopped'),
    Bun.sleep(2_000).then(() => 'still waiting'),
  ]);
  expect(stopped).toBe('stopped');
  // The client sees the stream end (or break), not hang.
  const after = await Promise.race([
    reader.read().then(
      (chunk) => (chunk.done ? 'ended' : 'data'),
      () => 'ended'
    ),
    Bun.sleep(2_000).then(() => 'hung'),
  ]);
  expect(after).toBe('ended');
});
