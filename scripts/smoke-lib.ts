/**
 * Helpers of `smoke-gcp.ts` and `smoke-aws.ts`: a step report, a small HTTP caller, and a reader of the Control API's
 * server-sent event stream. Nothing here prints a token: a bearer value is passed in and only ever
 * put in an Authorization header.
 */

export interface Outcome {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
  readonly ms: number;
}

export class SmokeFailure extends Error {}

export class Report {
  readonly outcomes: Outcome[] = [];

  /** Runs one step. A failure is recorded and then stops the run: later steps depend on it. */
  async step<T>(name: string, run: () => Promise<T>, describe?: (value: T) => string): Promise<T> {
    const started = Date.now();
    try {
      const value = await run();
      this.#add(name, true, describe === undefined ? '' : describe(value), started);
      return value;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.#add(name, false, detail, started);
      throw new SmokeFailure(`${name}: ${detail}`);
    }
  }

  /** Like `step`, but the run goes on: for drills that do not depend on one another. */
  async drill<T>(name: string, run: () => Promise<T>, describe?: (value: T) => string): Promise<void> {
    await this.step(name, run, describe).catch(() => undefined);
  }

  get failed(): boolean {
    return this.outcomes.some((outcome) => !outcome.ok);
  }

  print(write: (line: string) => void): void {
    for (const outcome of this.outcomes) {
      const detail = outcome.detail === '' ? '' : `  ${outcome.detail}`;
      write(`${outcome.ok ? 'ok  ' : 'FAIL'} ${outcome.name} (${outcome.ms} ms)${detail}`);
    }
    const bad = this.outcomes.filter((outcome) => !outcome.ok).length;
    write(bad === 0 ? `all ${this.outcomes.length} checks passed` : `${bad} of ${this.outcomes.length} checks failed`);
  }

  #add(name: string, ok: boolean, detail: string, started: number): void {
    this.outcomes.push({ name, ok, detail, ms: Date.now() - started });
  }
}

export function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export interface Reply {
  readonly status: number;
  readonly headers: Headers;
  readonly json: any;
}

export async function call(
  base: string,
  path: string,
  options: { method?: string; token?: string; body?: unknown; headers?: Record<string, string> } = {}
): Promise<Reply> {
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(new URL(path, base), {
    method: options.method ?? 'GET',
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  let json: unknown = null;
  try {
    json = text === '' ? null : JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, headers: response.headers, json };
}

export interface Frame {
  readonly id: string | null;
  readonly event: string;
  readonly data: any;
}

/** One open event stream: frames are collected as they arrive, and `waitFor` returns the first that matches. */
export class EventWatch {
  readonly frames: Frame[] = [];
  readonly #abort = new AbortController();
  #wake: (() => void) | null = null;
  #ended: Error | null = null;

  private constructor() {}

  /** Opens the stream and returns once the server's `connected` frame has arrived. */
  static async open(base: string, path: string, token: string): Promise<EventWatch> {
    const watch = new EventWatch();
    const response = await fetch(new URL(path, base), {
      headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' },
      signal: watch.#abort.signal,
    });
    expect(response.status === 200, `the event stream answered ${response.status}`);
    expect(
      (response.headers.get('content-type') ?? '').startsWith('text/event-stream'),
      'the event stream is not text/event-stream'
    );
    void watch.#read(response.body!);
    await watch.waitFor((frame) => frame.data?.connected === true, 10_000);
    return watch;
  }

  async waitFor(match: (frame: Frame) => boolean, timeoutMs: number): Promise<Frame> {
    const deadline = Date.now() + timeoutMs;
    let seen = 0;
    for (;;) {
      for (; seen < this.frames.length; seen += 1) {
        if (match(this.frames[seen]!)) return this.frames[seen]!;
      }
      if (this.#ended !== null) throw this.#ended;
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`no matching event in ${timeoutMs} ms (${this.frames.length} frames seen)`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left);
        this.#wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
  }

  /** Why the stream is no longer open, or null while it is. */
  get ended(): Error | null {
    return this.#ended;
  }

  close(): void {
    this.#abort.abort();
  }

  async #read(body: ReadableStream<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true });
        for (let end = buffer.indexOf('\n\n'); end >= 0; end = buffer.indexOf('\n\n')) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const frame = parseFrame(block);
          if (frame !== null) this.frames.push(frame);
        }
        this.#wake?.();
      }
      this.#ended = new Error('the event stream ended');
    } catch (error) {
      this.#ended = this.#abort.signal.aborted ? new Error('closed') : (error as Error);
    }
    this.#wake?.();
  }
}

function parseFrame(block: string): Frame | null {
  let id: string | null = null;
  let event = 'message';
  const data: string[] = [];
  for (const line of block.split('\n')) {
    if (line.startsWith(':') || line.startsWith('retry:')) continue;
    if (line.startsWith('id:')) id = line.slice(3).trim();
    else if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
  }
  if (data.length === 0) return null;
  try {
    return { id, event, data: JSON.parse(data.join('\n')) };
  } catch {
    return { id, event, data: null };
  }
}

export async function until<T>(
  what: string,
  timeoutMs: number,
  read: () => Promise<T | null | undefined | false>,
  everyMs = 500
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read().catch(() => null);
    if (value !== null && value !== undefined && value !== false) return value;
    if (Date.now() >= deadline) throw new Error(`${what} did not happen within ${timeoutMs} ms`);
    await Bun.sleep(everyMs);
  }
}
