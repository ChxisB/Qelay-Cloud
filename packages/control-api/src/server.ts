import type { ControlApp } from './app';

export interface RunningServer {
  readonly url: URL;
  readonly port: number;
  /**
   * Stops accepting connections and waits for requests in flight. An open event stream is one, so
   * a shutdown that must finish passes `true` to close every connection now.
   */
  stop(force?: boolean): Promise<void>;
}

export interface ListenOptions {
  /** Default `127.0.0.1`. A container sets `0.0.0.0` through `QCLOUD_API_HOST`. */
  readonly hostname?: string;
  /** Default 8080; 0 picks a free port. */
  readonly port?: number;
}

/**
 * Serves `app` with `Bun.serve`. The socket layer gets the largest body any route accepts, so an
 * oversized upload is cut off before it reaches a handler; each route's own cap is applied by the
 * app. `idleTimeout` is the most Bun allows, because the app enforces its own request deadlines.
 */
export function startControlApi(app: ControlApp, options: ListenOptions = {}): RunningServer {
  const server = Bun.serve({
    hostname: options.hostname ?? '127.0.0.1',
    port: options.port ?? 8080,
    maxRequestBodySize: app.maxBodyBytes,
    idleTimeout: 255,
    fetch: (request) => app.handle(request),
  });
  return {
    url: server.url,
    port: server.port ?? 0,
    stop: (force = false) => server.stop(force),
  };
}
