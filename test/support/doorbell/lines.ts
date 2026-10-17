import { waitFor } from './util';

/** Line-by-line reader over a child's stdout. */
export class Lines {
  readonly #lines: string[] = [];

  constructor(stream: ReadableStream<Uint8Array>) {
    void this.#pump(stream);
  }

  async #pump(stream: ReadableStream<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of stream) {
      buffer += decoder.decode(chunk, { stream: true });
      for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
        this.#lines.push(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
      }
    }
  }

  async next(what: string, timeoutMs = 15_000): Promise<string> {
    await waitFor(() => this.#lines.length > 0, what, timeoutMs);
    return this.#lines.shift()!;
  }
}
