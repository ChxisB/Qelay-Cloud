import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import {
  E2E_API_PORT,
  E2E_APP_URL,
  E2E_CONTROL_PORT,
  E2E_CONTROL_URL,
  E2E_DASHBOARD_PORT,
  E2E_LOOPBACK_HOST,
  E2E_ORIGIN,
  E2E_VIEWER_API_PORT,
  E2E_VIEWER_URL,
} from '../e2e/config';
import { acceptsTcpConnection } from '../e2e/networkPolicy';

describe('browser E2E network policy', () => {
  test('every address the specs use is on loopback, on ports of their own', () => {
    expect(E2E_LOOPBACK_HOST).toBe('127.0.0.1');
    for (const url of [E2E_ORIGIN, E2E_APP_URL, E2E_VIEWER_URL, E2E_CONTROL_URL]) {
      expect(new URL(url).hostname).toBe(E2E_LOOPBACK_HOST);
    }
    const ports = [E2E_DASHBOARD_PORT, E2E_CONTROL_PORT, E2E_API_PORT, E2E_VIEWER_API_PORT];
    expect(new Set(ports).size).toBe(ports.length);
  });

  test('the stack binds only to the loopback constant, never to a wildcard', () => {
    // The runtime and the static server it starts (split out for the 300-line rule) are the two files that bind.
    const source = ['runtime.ts', 'panelServer.ts']
      .map((file) => readFileSync(new URL(`../e2e/${file}`, import.meta.url), 'utf8'))
      .join('\n');
    const hostnames = [...source.matchAll(/hostname:\s*([^,}\s]+)/g)].map((match) => match[1]);
    expect(hostnames.length).toBeGreaterThanOrEqual(3);
    for (const hostname of hostnames) expect(hostname).toBe('E2E_LOOPBACK_HOST');
    expect(source).not.toContain('0.0.0.0');
  });

  test('the bind probe tells a listening port from a closed one', async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, E2E_LOOPBACK_HOST, resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    expect(await acceptsTcpConnection(E2E_LOOPBACK_HOST, port)).toBe(true);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(await acceptsTcpConnection(E2E_LOOPBACK_HOST, port)).toBe(false);
  });
});
