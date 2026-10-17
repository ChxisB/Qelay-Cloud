import type { Harness } from './support';
import { DEV_TOKEN } from './support';

/** One server-sent event as a client assembles it. A comment frame has only `comment`. */
export interface Frame {
  readonly id?: string;
  readonly event?: string;
  readonly data?: string;
  readonly retry?: string;
  readonly comment?: string;
}

/** The JSON of a frame's `data`. */
export const dataOf = (frame: Frame): Record<string, any> => JSON.parse(frame.data ?? 'null');

/** One frame's text (without the blank line that ends it). */
export function parseFrame(raw: string): Frame {
  const fields: Record<string, string> = {};
  const comments: string[] = [];
  for (const line of raw.split('\n')) {
    if (line.startsWith(':')) {
      comments.push(line.slice(1).trim());
      continue;
    }
    const colon = line.indexOf(':');
    const name = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
    fields[name] = fields[name] === undefined ? value : `${fields[name]}\n${value}`;
  }
  return {
    ...(fields.id === undefined ? {} : { id: fields.id }),
    ...(fields.event === undefined ? {} : { event: fields.event }),
    ...(fields.data === undefined ? {} : { data: fields.data }),
    ...(fields.retry === undefined ? {} : { retry: fields.retry }),
    ...(comments.length === 0 ? {} : { comment: comments.join('\n') }),
  };
}

const withTimeout = async <T>(work: Promise<T>, ms: number, what: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms waiting for ${what}`)), ms);
  });
  try {
    return await Promise.race([work, late]);
  } finally {
    clearTimeout(timer);
  }
};

/** Reads an event stream a frame at a time, the way a browser's `EventSource` splits it. */
export class FrameReader {
  readonly #reader: {
    read(): Promise<{ done: boolean; value?: Uint8Array }>;
    cancel(reason?: unknown): Promise<void>;
  };
  readonly #decoder = new TextDecoder();
  #buffer = '';

  constructor(readonly response: Response) {
    if (response.body === null) throw new Error('the response has no body');
    this.#reader = response.body.getReader();
  }

  /** The next frame's text as it was sent, or null when the stream ended. A stream that errors rejects. */
  async nextRaw(timeoutMs = 3_000): Promise<string | null> {
    for (;;) {
      const cut = this.#buffer.indexOf('\n\n');
      if (cut >= 0) {
        const raw = this.#buffer.slice(0, cut);
        this.#buffer = this.#buffer.slice(cut + 2);
        return raw;
      }
      const chunk = await withTimeout(this.#reader.read(), timeoutMs, 'a frame');
      if (chunk.done) return null;
      this.#buffer += this.#decoder.decode(chunk.value, { stream: true });
    }
  }

  /** The next frame, or null when the stream ended. A stream that errors rejects. */
  async next(timeoutMs = 3_000): Promise<Frame | null> {
    const raw = await this.nextRaw(timeoutMs);
    return raw === null ? null : parseFrame(raw);
  }

  /** The next `count` frames that carry an event (comments and the handshake are skipped). */
  async events(count: number, timeoutMs = 3_000): Promise<Frame[]> {
    const found: Frame[] = [];
    while (found.length < count) {
      const frame = await this.next(timeoutMs);
      if (frame === null)
        throw new Error(`the stream ended after ${found.length} of ${count} events`);
      if (frame.event !== undefined) found.push(frame);
    }
    return found;
  }

  /** The next comment frame's text. Event frames before it are dropped. */
  async comment(timeoutMs = 3_000): Promise<string> {
    for (;;) {
      const frame = await this.next(timeoutMs);
      if (frame === null) throw new Error('the stream ended before a comment');
      if (frame.comment !== undefined) return frame.comment;
    }
  }

  /** Every frame up to the end of the stream. */
  async rest(timeoutMs = 3_000): Promise<Frame[]> {
    const frames: Frame[] = [];
    for (
      let frame = await this.next(timeoutMs);
      frame !== null;
      frame = await this.next(timeoutMs)
    ) {
      frames.push(frame);
    }
    return frames;
  }

  /** Hangs up, as a client closing its tab does. */
  async cancel(): Promise<void> {
    await this.#reader.cancel().catch(() => undefined);
  }
}

export interface OpenInit {
  readonly headers?: Record<string, string>;
  readonly signal?: AbortSignal;
  /** Null sends no credentials. */
  readonly token?: string | null;
}

/** `GET path` as a streaming client: nothing buffers the body, and the request can carry a signal. */
export function openStream(api: Harness, path: string, init: OpenInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  const token = init.token === undefined ? DEV_TOKEN : init.token;
  if (token !== null) headers.set('authorization', `Bearer ${token}`);
  return api.app.handle(
    new Request(`http://api.test${path}`, {
      method: 'GET',
      headers,
      ...(init.signal === undefined ? {} : { signal: init.signal }),
    })
  );
}

/** Opens a stream that is expected to start and returns its reader with the handshake read. */
export async function connect(
  api: Harness,
  path: string,
  init: OpenInit = {}
): Promise<{ reader: FrameReader; handshake: Frame }> {
  const response = await openStream(api, path, init);
  if (response.status !== 200) throw new Error(`the stream answered ${response.status}`);
  const reader = new FrameReader(response);
  const handshake = await reader.next();
  if (handshake === null) throw new Error('the stream ended before the handshake');
  return { reader, handshake };
}

/** Polls until `ready` is true, for state that changes on a timer the test does not own. */
export async function eventually(ready: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error('the condition did not become true in time');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
