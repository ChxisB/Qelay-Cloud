import { describe, expect, test } from 'bun:test';
import { DEFAULT_USER_AGENT, NO_BODY, readBody } from '../src/webhookHttp';
import { postOverSocket } from '../src/webhookPool';
import { sendDelivery } from '../src/webhookSend';
import { listener, request } from './webhookSockets';
import { delivery, script } from './webhookSupport';

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

describe('readBody', () => {
  test('reads a body by length, cut to the cap, with control characters made spaces', () => {
    const raw = bytes('HTTP/1.1 500 X\r\nContent-Length: 13\r\n\r\nbad\u0007 thing\n!!');
    expect(readBody(raw, 500, 100)).toEqual({ text: 'bad  thing\n!!', done: true });
    expect(readBody(raw, 500, 5)).toEqual({ text: 'bad', done: true });
  });

  test('waits for the rest of a body that has not arrived, and for the end of the headers', () => {
    expect(readBody(bytes('HTTP/1.1 500 X\r\nContent-Length: 9\r\n\r\nabc'), 500, 100).done).toBe(
      false
    );
    expect(readBody(bytes('HTTP/1.1 500 X\r\nContent-Le'), 500, 100).done).toBe(false);
  });

  test('de-chunks, and keeps nothing it cannot read as plain text', () => {
    const chunked = bytes(
      'HTTP/1.1 502 X\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n2\r\nde\r\n0\r\n\r\n'
    );
    expect(readBody(chunked, 502, 100)).toEqual({ text: 'abcde', done: true });
    const gzip = bytes('HTTP/1.1 502 X\r\nContent-Encoding: gzip\r\nContent-Length: 3\r\n\r\nabc');
    expect(readBody(gzip, 502, 100)).toEqual(NO_BODY);
    expect(readBody(bytes('HTTP/1.1 304 X\r\n\r\n'), 304, 100)).toEqual(NO_BODY);
  });
});

describe('a failed answer', () => {
  const wire = (status: number, body: string): string =>
    `HTTP/1.1 ${status} X\r\nContent-Length: ${body.length}\r\n\r\n${body}`;

  test('carries the first bytes of its body when asked, and never otherwise', async () => {
    const server = listener((s) => {
      s.write(wire(500, `{"error":"${'e'.repeat(5_000)}"}`));
      s.end();
    });
    try {
      const kept = await postOverSocket(request(server.port, { captureBytes: 40 }));
      expect(kept).toEqual({ kind: 'status', status: 500, body: `{"error":"${'e'.repeat(30)}` });
      expect(await postOverSocket(request(server.port))).toEqual({ kind: 'status', status: 500 });
    } finally {
      server.stop();
    }
  });

  test('is held until its body is in, and answers with what came if the body is cut', async () => {
    const slow = listener((s) => {
      s.write('HTTP/1.1 503 X\r\nContent-Length: 11\r\n\r\nback ');
      setTimeout(() => s.write('later'), 30);
    });
    const cut = listener((s) => {
      s.write('HTTP/1.1 503 X\r\nContent-Length: 50\r\n\r\ngone away');
      s.end();
    });
    try {
      expect(await postOverSocket(request(slow.port, { captureBytes: 99 }))).toEqual({
        kind: 'status',
        status: 503,
        body: 'back later',
      });
      expect(await postOverSocket(request(cut.port, { captureBytes: 99 }))).toEqual({
        kind: 'status',
        status: 503,
        body: 'gone away',
      });
    } finally {
      slow.stop();
      cut.stop();
    }
  });

  test('a success is answered at its status line and keeps no body', async () => {
    const server = listener((s) => s.write(wire(200, 'welcome')));
    try {
      expect(await postOverSocket(request(server.port, { captureBytes: 99 }))).toEqual({
        kind: 'status',
        status: 200,
      });
    } finally {
      server.stop();
    }
  });

  test('is recorded on the attempt, for a failure only', async () => {
    const server = listener((s) => {
      s.write(wire(500, 'database is down'));
      s.end();
    });
    try {
      const deps = script().deps({
        urlPolicy: { allowHttp: true, allowPrivate: true },
        post: postOverSocket,
        captureBytes: 1_024,
      });
      const result = await sendDelivery(
        delivery({ url: `http://127.0.0.1:${server.port}/h` }),
        deps
      );
      expect(result).toMatchObject({ ok: false, statusCode: 500, response: 'database is down' });
    } finally {
      server.stop();
    }
  });
});

describe('the User-Agent header', () => {
  test('is the default, or the one given', async () => {
    const server = listener((s) => {
      s.write('HTTP/1.1 204 X\r\n\r\n');
      s.end();
    });
    try {
      await postOverSocket(request(server.port));
      await postOverSocket(request(server.port, { userAgent: 'acme-hooks/2' }));
      expect(server.requests[0]).toContain(`User-Agent: ${DEFAULT_USER_AGENT}\r\n`);
      expect(server.requests[1]).toContain('User-Agent: acme-hooks/2\r\n');
    } finally {
      server.stop();
    }
  });
});
