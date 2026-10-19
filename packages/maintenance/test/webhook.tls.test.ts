import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { postOverSocket } from '../src/webhookPool';
import { listener, request } from './webhookSockets';

const opensslAvailable = Bun.which('openssl') !== null;

describe.skipIf(!opensslAvailable)('webhook http client over TLS', () => {
  let dir = '';
  let cert = '';
  let key = '';
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'qcloud-webhook-tls-'));
    const made = Bun.spawnSync([
      'openssl',
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-keyout',
      join(dir, 'key.pem'),
      '-out',
      join(dir, 'cert.pem'),
      '-subj',
      '/CN=hooks.example.test',
      '-addext',
      'subjectAltName=DNS:hooks.example.test',
    ]);
    if (made.exitCode !== 0) throw new Error('could not make a throwaway certificate');
    cert = await readFile(join(dir, 'cert.pem'), 'utf8');
    key = await readFile(join(dir, 'key.pem'), 'utf8');
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function tlsServer() {
    const seen: string[] = [];
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      tls: { cert, key },
      fetch: async (incoming) => {
        seen.push(`${incoming.method} ${new URL(incoming.url).pathname} ${await incoming.text()}`);
        return new Response('received', { status: 200 });
      },
    });
    return { port: server.port!, seen, stop: () => server.stop(true) };
  }

  test('a certificate for the name the operator wrote is accepted, with the pinned address', async () => {
    const server = tlsServer();
    try {
      const result = await postOverSocket(
        request(server.port, {
          secure: true,
          serverName: 'hooks.example.test',
          hostHeader: 'hooks.example.test',
          ca: cert,
        })
      );
      expect(result).toEqual({ kind: 'status', status: 200 });
      expect(server.seen).toEqual(['POST /hook {"ok":true}']);
    } finally {
      server.stop();
    }
  });

  test('a certificate for another name is refused, and nothing is sent', async () => {
    const server = tlsServer();
    try {
      const result = await postOverSocket(
        request(server.port, {
          secure: true,
          serverName: 'other.example.test',
          hostHeader: 'other.example.test',
          ca: cert,
        })
      );
      expect(result).toEqual({ kind: 'failed', failure: 'tls' });
      expect(server.seen).toEqual([]);
    } finally {
      server.stop();
    }
  });

  test('a certificate the system does not trust is refused, and nothing is sent', async () => {
    const server = tlsServer();
    try {
      const result = await postOverSocket(
        request(server.port, {
          secure: true,
          serverName: 'hooks.example.test',
          hostHeader: 'hooks.example.test',
        })
      );
      expect(result).toEqual({ kind: 'failed', failure: 'tls' });
      expect(server.seen).toEqual([]);
    } finally {
      server.stop();
    }
  });

  test('plain HTTP to a TLS port, and TLS to a plain port, are failures not hangs', async () => {
    const server = tlsServer();
    const plain = listener((s) => {
      s.write('HTTP/1.1 200 OK\r\n\r\n');
      s.end();
    });
    try {
      const toTls = await postOverSocket(request(server.port, { timeoutMs: 1_000 }));
      expect(toTls.kind).toBe('failed');
      const toPlain = await postOverSocket(
        request(plain.port, {
          secure: true,
          serverName: 'hooks.example.test',
          ca: cert,
          timeoutMs: 1_000,
        })
      );
      expect(toPlain.kind).toBe('failed');
    } finally {
      server.stop();
      plain.stop();
    }
  });
});
