export interface RunningIngest {
  readonly url: URL;
  readonly port: number;
  stop(force?: boolean): Promise<void>;
}

/** Slack over the body cap so the handler's own check runs and can store the refusal; Bun cuts off anything past it. */
const SOCKET_SLACK_BYTES = 65_536;
const MAX_IDLE_SECONDS = 255;

/**
 * Serves `handler` with `Bun.serve`. The socket takes the body cap plus a little, and an idle connection is closed soon
 * after the body deadline, so a slow sender holds a connection for seconds, not minutes.
 */
export function startIngest(
  handler: (request: Request) => Promise<Response>,
  options: { hostname: string; port: number; maxBodyBytes: number; readTimeoutMs: number }
): RunningIngest {
  const server = Bun.serve({
    hostname: options.hostname,
    port: options.port,
    maxRequestBodySize: options.maxBodyBytes + SOCKET_SLACK_BYTES,
    idleTimeout: Math.min(MAX_IDLE_SECONDS, Math.ceil(options.readTimeoutMs / 1000) + 5),
    fetch: handler,
  });
  return {
    url: server.url,
    port: server.port ?? 0,
    stop: (force = false) => server.stop(force),
  };
}
