import { afterEach, describe, expect, test } from 'bun:test';
import { createSocketPool } from '../src/webhookPool';
import { listener, request } from './webhookSockets';

const CLEAN = 'HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok';

describe('socket pool: keep-alive', () => {
  const stops: Array<() => void> = [];
  afterEach(() => {
    for (const stop of stops.splice(0)) stop();
  });
  const receiver = (reply: Parameters<typeof listener>[0]) => {
    const server = listener(reply);
    stops.push(server.stop);
    return server;
  };
  const pool = (keepAliveMs = 5_000) => {
    const made = createSocketPool({ keepAliveMs });
    stops.push(made.close);
    return made;
  };

  test('a clean answer leaves the connection for the next request', async () => {
    const server = receiver((socket) => socket.write(CLEAN));
    const { post, idle, close } = pool();
    expect(await post(request(server.port))).toEqual({ kind: 'status', status: 200 });
    expect(idle()).toBe(1);
    expect(await post(request(server.port))).toEqual({ kind: 'status', status: 200 });
    expect(server.connections()).toBe(1);
    expect(server.requests).toHaveLength(2);
    expect(server.requests[1]).toContain('Connection: keep-alive');
    close();
    expect(idle()).toBe(0);
  });

  test('an answer whose end is not known, or that is followed by more bytes, is not kept', async () => {
    const answers = [
      'HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok',
      'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2\r\nok\r\n0\r\n\r\n',
      'HTTP/1.0 200 OK\r\nContent-Length: 2\r\n\r\nok',
      'HTTP/1.1 200 OK\r\nContent-Length: 2\r\nContent-Length: 2\r\n\r\nok',
      `${CLEAN}HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n`,
    ];
    for (const answer of answers) {
      const server = receiver((socket) => socket.write(answer));
      const { post, idle } = pool();
      expect(await post(request(server.port))).toMatchObject({ kind: 'status', status: 200 });
      await Bun.sleep(20);
      expect(idle()).toBe(0);
      await post(request(server.port));
      expect(server.connections()).toBe(2);
    }
  });

  test('with keepAliveMs 0 every request asks the receiver to close', async () => {
    const server = receiver((socket) => socket.write(CLEAN));
    const { post, idle } = pool(0);
    await post(request(server.port));
    await post(request(server.port));
    expect(idle()).toBe(0);
    expect(server.connections()).toBe(2);
    expect(server.requests[0]).toContain('Connection: close');
  });

  test('a parked connection the receiver closed unread is replaced once, not reported as a failure', async () => {
    let calls = 0;
    const server = receiver((socket) => {
      calls += 1;
      if (calls === 2) socket.end();
      else socket.write(CLEAN);
    });
    const { post } = pool();
    await post(request(server.port));
    expect(await post(request(server.port))).toEqual({ kind: 'status', status: 200 });
    expect(server.connections()).toBe(2);
    expect(calls).toBe(3);
  });

  test('a fresh connection that fails is not retried', async () => {
    let calls = 0;
    const server = receiver((socket) => {
      calls += 1;
      socket.end();
    });
    const { post } = pool();
    expect(await post(request(server.port))).toEqual({ kind: 'failed', failure: 'reset' });
    expect(calls).toBe(1);
  });

  test('connections to different addresses or ports are not shared', async () => {
    const a = receiver((socket) => socket.write(CLEAN));
    const b = receiver((socket) => socket.write(CLEAN));
    const { post, idle } = pool();
    await post(request(a.port));
    await post(request(b.port));
    expect(idle()).toBe(2);
    expect(a.connections() + b.connections()).toBe(2);
  });

  test('an idle connection is closed after keepAliveMs', async () => {
    const server = receiver((socket) => socket.write(CLEAN));
    const { post, idle } = pool(50);
    await post(request(server.port));
    expect(idle()).toBe(1);
    await Bun.sleep(120);
    expect(idle()).toBe(0);
  });
});
