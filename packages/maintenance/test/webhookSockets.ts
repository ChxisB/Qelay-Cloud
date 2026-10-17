import type { PostRequest } from '../src/webhookHttp';

/** A raw TCP listener that answers each connection with `reply` and records what it was sent. */
export function listener(reply: (socket: { write(data: string): void; end(): void }) => void) {
  const requests: string[] = [];
  const server = Bun.listen<{ buffer: Buffer }>({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      open(socket) {
        socket.data = { buffer: Buffer.alloc(0) };
      },
      data(socket, chunk) {
        const buffer = Buffer.concat([socket.data.buffer, chunk]);
        socket.data.buffer = buffer;
        const split = buffer.indexOf('\r\n\r\n');
        if (split === -1) return;
        const length = Number(/content-length: (\d+)/iu.exec(buffer.toString('latin1'))?.[1] ?? 0);
        if (buffer.length - split - 4 < length) return;
        requests.push(buffer.toString('utf8'));
        socket.data.buffer = Buffer.alloc(0);
        reply(socket);
      },
    },
  });
  return { port: server.port, requests, stop: () => server.stop(true) };
}

export const request = (port: number, overrides: Partial<PostRequest> = {}): PostRequest => ({
  address: '127.0.0.1',
  port,
  secure: false,
  hostHeader: `127.0.0.1:${port}`,
  path: '/hook?a=1',
  headers: { 'X-Webhook-Id': '7' },
  body: '{"ok":true}',
  timeoutMs: 2_000,
  ...overrides,
});
