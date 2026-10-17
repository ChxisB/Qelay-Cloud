import { describe, expect, test } from 'bun:test';
import { MAX_STATUS_LINE_BYTES, postOverSocket } from '../src/webhookHttp';
import { sendDelivery } from '../src/webhookSend';
import { listener, request } from './webhookSockets';
import { delivery, script } from './webhookSupport';

describe('webhook http client over a real socket', () => {
  test('writes one well-formed request and reads the status', async () => {
    const server = listener((s) => {
      s.write('HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n\r\n');
      s.end();
    });
    try {
      expect(await postOverSocket(request(server.port))).toEqual({ kind: 'status', status: 204 });
      expect(server.requests).toHaveLength(1);
      const text = server.requests[0]!;
      expect(text.startsWith('POST /hook?a=1 HTTP/1.1\r\n')).toBe(true);
      expect(text).toContain(`Host: 127.0.0.1:${server.port}\r\n`);
      expect(text).toContain('Content-Type: application/json\r\n');
      expect(text).toContain('Content-Length: 11\r\n');
      expect(text).toContain('Connection: close\r\n');
      expect(text).toContain('X-Webhook-Id: 7\r\n');
      expect(text.endsWith('\r\n\r\n{"ok":true}')).toBe(true);
    } finally {
      server.stop();
    }
  });

  test('the length is in bytes, not characters', async () => {
    const server = listener((s) => {
      s.write('HTTP/1.1 200 OK\r\n\r\n');
      s.end();
    });
    try {
      await postOverSocket(request(server.port, { body: '{"queue":"é€"}' }));
      expect(server.requests[0]).toContain(
        `Content-Length: ${new TextEncoder().encode('{"queue":"é€"}').length}\r\n`
      );
    } finally {
      server.stop();
    }
  });

  test('a body larger than the socket buffer is written whole', async () => {
    const body = JSON.stringify({ filler: 'x'.repeat(2_000_000) });
    const server = listener((s) => {
      s.write('HTTP/1.1 200 OK\r\n\r\n');
      s.end();
    });
    try {
      expect(await postOverSocket(request(server.port, { body }))).toEqual({
        kind: 'status',
        status: 200,
      });
      expect(server.requests[0]!.endsWith(body)).toBe(true);
    } finally {
      server.stop();
    }
  });

  test.each([200, 301, 302, 404, 500, 503])(
    'reads a %i, and the body that follows is never read',
    async (status) => {
      const server = listener((s) => {
        // The answer is followed by far more body than anything should buffer.
        s.write(
          `HTTP/1.1 ${status} X\r\nLocation: http://169.254.169.254/\r\n\r\n${'secret-body '.repeat(50_000)}`
        );
        s.end();
      });
      try {
        expect(await postOverSocket(request(server.port))).toEqual({ kind: 'status', status });
      } finally {
        server.stop();
      }
    }
  );

  test('a status line that arrives in pieces is read', async () => {
    const server = listener((s) => {
      s.write('HTTP/1.');
      setTimeout(() => s.write('1 20'), 20);
      setTimeout(() => s.write('2 Accepted\r\n\r\n'), 40);
    });
    try {
      expect(await postOverSocket(request(server.port))).toEqual({ kind: 'status', status: 202 });
    } finally {
      server.stop();
    }
  });

  test('a redirect is reported and its Location is never contacted', async () => {
    const target = listener((s) => s.end());
    const server = listener((s) => {
      s.write(`HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:${target.port}/elsewhere\r\n\r\n`);
      s.end();
    });
    try {
      const result = await sendDelivery(
        delivery({ url: `http://127.0.0.1:${server.port}/hook` }),
        script().deps({
          urlPolicy: { allowHttp: true, allowPrivate: true },
          post: postOverSocket,
        })
      );
      expect(result).toMatchObject({
        ok: false,
        statusCode: 302,
        error: 'redirect not followed (302)',
      });
      expect(target.requests).toEqual([]);
      expect(server.requests).toHaveLength(1);
    } finally {
      server.stop();
      target.stop();
    }
  });

  test.each([
    ['not HTTP', 'SSH-2.0-OpenSSH\r\n'],
    ['an HTTP/2 line', 'HTTP/2 200\r\n'],
    ['an interim 100', 'HTTP/1.1 100 Continue\r\n\r\n'],
    ['a status that is not three digits', 'HTTP/1.1 20 OK\r\n'],
    ['no status code', 'HTTP/1.1 OK\r\n'],
  ])('%s is a protocol failure', async (_label, reply) => {
    const server = listener((s) => s.write(reply));
    try {
      expect(await postOverSocket(request(server.port))).toEqual({
        kind: 'failed',
        failure: 'protocol',
      });
    } finally {
      server.stop();
    }
  });

  test('a flood with no line break is cut off at the status line cap', async () => {
    const server = listener((s) => {
      s.write('A'.repeat(MAX_STATUS_LINE_BYTES + 1));
    });
    try {
      expect(await postOverSocket(request(server.port))).toEqual({
        kind: 'failed',
        failure: 'protocol',
      });
    } finally {
      server.stop();
    }
  });

  test('a receiver that never answers times out at the deadline', async () => {
    const server = listener(() => {});
    try {
      const started = performance.now();
      expect(await postOverSocket(request(server.port, { timeoutMs: 150 }))).toEqual({
        kind: 'failed',
        failure: 'timeout',
      });
      const took = performance.now() - started;
      expect(took).toBeGreaterThanOrEqual(140);
      expect(took).toBeLessThan(1_500);
    } finally {
      server.stop();
    }
  });

  test('a receiver that sends a byte every so often is still bound by the whole-exchange deadline', async () => {
    const server = listener((s) => {
      const drip = setInterval(() => s.write(' '), 30);
      setTimeout(() => clearInterval(drip), 2_000);
    });
    try {
      const started = performance.now();
      expect(await postOverSocket(request(server.port, { timeoutMs: 200 }))).toEqual({
        kind: 'failed',
        failure: 'timeout',
      });
      expect(performance.now() - started).toBeLessThan(1_500);
    } finally {
      server.stop();
    }
  });

  test('a connection closed with no answer is a reset', async () => {
    const server = listener((s) => s.end());
    try {
      expect(await postOverSocket(request(server.port))).toEqual({
        kind: 'failed',
        failure: 'reset',
      });
    } finally {
      server.stop();
    }
  });

  test('a closed port is refused', async () => {
    const server = listener(() => {});
    const { port } = server;
    server.stop();
    expect(await postOverSocket(request(port))).toEqual({ kind: 'failed', failure: 'refused' });
  });
});
