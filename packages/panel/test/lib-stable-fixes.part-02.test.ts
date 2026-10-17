import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { useConnectionStore } from '../src/components/dashboard/stores/connectionStore';
import { useActivityStream } from '../src/lib/useActivityStream';
import { renderHook, settle } from './domSetup';

// useActivityStream regressions: job:progress inflated the "active" counter, and
// the reconnect backoff never reset after a healthy connection that later failed.

const encoder = new TextEncoder();
const realFetch = globalThis.fetch;
const realSetTimeout = globalThis.setTimeout;
let controllers: ReadableStreamDefaultController<Uint8Array>[] = [];

function sseResponse(start?: (c: ReadableStreamDefaultController<Uint8Array>) => void) {
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controllers.push(c);
      start?.(c);
    },
  });
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

const frame = (event: string, data: Record<string, unknown>) =>
  encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

beforeEach(() => {
  controllers = [];
  useConnectionStore.setState({ baseUrl: 'http://srv', token: '' });
});

afterEach(() => {
  for (const c of controllers) {
    try {
      c.close();
    } catch {
      /* already closed or errored */
    }
  }
  globalThis.fetch = realFetch;
  globalThis.setTimeout = realSetTimeout;
  useConnectionStore.setState({ baseUrl: '/api', token: '' });
});

describe('useActivityStream counters', () => {
  test('job:progress keeps the active row colour but is not counted as an activation', async () => {
    globalThis.fetch = (() => Promise.resolve(sseResponse())) as unknown as typeof fetch;
    const h = renderHook(() => useActivityStream());
    await settle(5);
    const push = (bytes: Uint8Array) => controllers.at(-1)?.enqueue(bytes);
    push(encoder.encode('data: {"connected":true}\n\n'));
    push(frame('job:active', { queue: 'q', jobId: 'a' }));
    for (const progress of [10, 50, 90]) {
      push(frame('job:progress', { queue: 'q', jobId: 'a', progress }));
    }
    push(frame('job:pulled', { queue: 'q', jobId: 'b' }));
    await settle(200); // > the 150ms flush timer

    const { events, counters } = h.result.current;
    expect(events.filter((e) => e.event === 'job:progress').map((e) => e.status)).toEqual([
      'active',
      'active',
      'active',
    ]);
    expect(counters).toEqual({ total: 5, completed: 0, failed: 0, waiting: 0, active: 2 });
    h.unmount();
  });
});

describe('useActivityStream reconnect backoff', () => {
  test('a connection that delivered frames restarts the backoff when it later errors', async () => {
    // Record each reconnect wait (multiples of the 2s base) but run it quickly.
    const waits: number[] = [];
    globalThis.setTimeout = ((handler: () => void, ms?: number, ...args: unknown[]) => {
      if (typeof ms === 'number' && ms >= 2000 && ms <= 16_000 && ms % 2000 === 0) {
        waits.push(ms);
        return realSetTimeout(handler, 5, ...args);
      }
      return realSetTimeout(handler, ms, ...args);
    }) as typeof setTimeout;

    let calls = 0;
    globalThis.fetch = (() => {
      calls += 1;
      // Three refused connects grow the backoff to 6s.
      if (calls <= 3) return Promise.resolve(new Response('down', { status: 503 }));
      // Then a healthy stream delivers a frame before the link resets.
      if (calls === 4) {
        return Promise.resolve(
          sseResponse((c) => {
            c.enqueue(encoder.encode('data: {"connected":true}\n\n'));
            realSetTimeout(() => c.error(new Error('connection reset')), 30);
          })
        );
      }
      return Promise.resolve(sseResponse());
    }) as unknown as typeof fetch;

    const h = renderHook(() => useActivityStream());
    for (let i = 0; i < 40 && calls < 5; i++) await settle(10);
    expect(calls).toBe(5);
    // Before the fix the fourth wait continued the old streak (8000 ms).
    expect(waits).toEqual([2000, 4000, 6000, 2000]);
    h.unmount();
  });
});
