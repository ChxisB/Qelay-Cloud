import { until } from './workerSupport';

/** Line-by-line reader over a child's stdout. */
export class Lines {
  readonly all: string[] = [];
  #next = 0;

  constructor(stream: ReadableStream<Uint8Array>) {
    void this.#pump(stream);
  }

  async #pump(stream: ReadableStream<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of stream) {
      buffer += decoder.decode(chunk, { stream: true });
      for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
        this.all.push(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
      }
    }
  }

  /** The next line not yet returned; fails the test after `ms`. */
  async next(what: string, ms = 15_000): Promise<string> {
    await until(what, () => this.all.length > this.#next, ms);
    return this.all[this.#next++]!;
  }
}
