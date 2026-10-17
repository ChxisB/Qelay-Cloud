/**
 * A loopback TCP proxy for faking what a network does to a database connection: added latency, a
 * connection reset (`sever`, what a Cloud SQL HA failover or a pooler restart looks like to a
 * client), a silent stall (`blackhole`, what a failover that drops packets looks like until a
 * timeout fires) and a refused connection (`refuse`, a database that is down).
 *
 * Test use only: it binds to 127.0.0.1 and forwards to one target.
 */
type Pipe = {
  client: Bun.Socket<Pipe>;
  upstream: Bun.Socket<Pipe> | null;
  /** Bytes from the client received before the upstream connection was ready. */
  pending: Uint8Array[];
};

export interface TcpProxyOptions {
  readonly targetHost: string;
  readonly targetPort: number;
  /** Added to every chunk in each direction, so a round trip costs twice this. */
  readonly latencyMs?: number;
}

export class TcpProxy {
  readonly #options: TcpProxyOptions;
  readonly #pipes = new Set<Pipe>();
  #listener: Bun.TCPSocketListener<Pipe> | null = null;
  #blackholed = false;
  #latencyMs: number;
  /** Connections accepted since the proxy started. */
  accepted = 0;

  private constructor(options: TcpProxyOptions) {
    this.#options = options;
    this.#latencyMs = options.latencyMs ?? 0;
  }

  static async start(options: TcpProxyOptions): Promise<TcpProxy> {
    const proxy = new TcpProxy(options);
    await proxy.#listen(0);
    return proxy;
  }

  get port(): number {
    if (!this.#listener) throw new Error('The proxy is not listening');
    return this.#listener.port;
  }

  get connections(): number {
    return this.#pipes.size;
  }

  setLatency(ms: number): void {
    this.#latencyMs = ms;
  }

  /** Resets every open connection at once. New connections still succeed. */
  sever(): void {
    for (const pipe of [...this.#pipes]) this.#close(pipe);
  }

  /** Keeps connections open but forwards nothing, in either direction. */
  blackhole(on: boolean): void {
    this.#blackholed = on;
  }

  /** Stops accepting (new connections are refused) and resets the open ones. */
  async refuse(): Promise<void> {
    const port = this.port;
    this.#listener?.stop(true);
    this.#listener = null;
    this.sever();
    this.#refusedPort = port;
  }

  /** Accepts again on the port `refuse` released. */
  async accept(): Promise<void> {
    if (this.#listener) return;
    await this.#listen(this.#refusedPort);
  }

  async stop(): Promise<void> {
    this.#listener?.stop(true);
    this.#listener = null;
    this.sever();
  }

  #refusedPort = 0;

  async #listen(port: number): Promise<void> {
    const forward = (
      to: Bun.Socket<Pipe> | null,
      chunk: Uint8Array,
      pipe: Pipe,
      fromClient: boolean
    ) => {
      const send = () => {
        if (this.#blackholed) return;
        if (fromClient && !pipe.upstream) pipe.pending.push(chunk);
        else to?.write(chunk);
      };
      if (this.#latencyMs > 0) setTimeout(send, this.#latencyMs);
      else send();
    };
    this.#listener = Bun.listen<Pipe>({
      hostname: '127.0.0.1',
      port,
      socket: {
        open: (client) => {
          this.accepted++;
          const pipe: Pipe = { client, upstream: null, pending: [] };
          client.data = pipe;
          this.#pipes.add(pipe);
          void Bun.connect<Pipe>({
            hostname: this.#options.targetHost,
            port: this.#options.targetPort,
            data: pipe,
            socket: {
              open: (upstream) => {
                pipe.upstream = upstream;
                for (const chunk of pipe.pending.splice(0)) upstream.write(chunk);
              },
              data: (_upstream, chunk) => forward(pipe.client, chunk, pipe, false),
              close: () => this.#close(pipe),
              error: () => this.#close(pipe),
              connectError: () => this.#close(pipe),
            },
          });
        },
        data: (client, chunk) => forward(client.data.upstream, chunk, client.data, true),
        close: (client) => this.#close(client.data),
        error: (client) => this.#close(client.data),
      },
    });
  }

  #close(pipe: Pipe): void {
    if (!this.#pipes.delete(pipe)) return;
    pipe.client.terminate();
    pipe.upstream?.terminate();
  }
}
