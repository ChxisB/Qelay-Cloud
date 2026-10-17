import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { UnsupportedOptionError } from '@qelay-cloud/core';
import type { PostgresStore } from '@qelay-cloud/store-postgres';
import { MemoryTransport } from '@qelay-cloud/transport-local';
import { Queue } from '../src';

const transport = new MemoryTransport();
const url = 'postgres://nobody:nothing@127.0.0.1:1/none';

function build(options: Record<string, unknown>, name = 'q'): Queue {
  return new Queue(name, { transport, databaseUrl: url, ...options } as never);
}

describe('queue: construction', () => {
  test('a queue opens no connection: constructing one against a dead address succeeds', async () => {
    const queue = build({});
    expect(queue.name).toBe('q');
    await queue.close();
  });

  test('a transport is required', () => {
    expect(() => new Queue('q', { databaseUrl: url } as never)).toThrow(UnsupportedOptionError);
    expect(() => new Queue('q', { databaseUrl: url } as never)).toThrow(/transport/);
  });

  test('a database is required, as a url or as connection options', () => {
    expect(() => new Queue('q', { transport } as never)).toThrow(/databaseUrl/);
    const database = { host: '127.0.0.1', database: 'x', username: 'u', password: 'p' };
    expect(() => build({ databaseUrl: undefined, database })).not.toThrow();
  });

  test('a url given twice is refused', () => {
    expect(() => build({ database: { url } })).toThrow(/conflicts with database.url/);
  });

  test('a store cannot be combined with a url, connection options or a namespace', () => {
    const store = {} as PostgresStore;
    for (const extra of [{ databaseUrl: url }, { database: {} }, { namespace: 'n' }]) {
      expect(() => new Queue('q', { transport, store, ...extra } as never)).toThrow(
        /cannot be combined/
      );
    }
  });

  test('a queue name must be a non-empty string without NUL', () => {
    for (const bad of ['', 'a\0b', null, 7]) {
      expect(() => build({}, bad as never)).toThrow(UnsupportedOptionError);
    }
  });

  test('defaultJobOptions are validated at construction', () => {
    expect(() => build({ defaultJobOptions: { repeat: { every: 1 } } })).toThrow(
      UnsupportedOptionError
    );
    expect(() => build({ defaultJobOptions: { attempts: 3 } })).not.toThrow();
  });
});

describe('queue: Qelay options that are refused', () => {
  const legacy: Array<[string, unknown]> = [
    ['host', '127.0.0.1'],
    ['port', 6379],
    ['connection', { host: 'h' }],
    ['embedded', true],
    ['dataPath', '/tmp/x'],
    ['autoBatch', true],
    ['prefixKey', 'p'],
  ];

  for (const [key, value] of legacy) {
    test(`${key} throws UnsupportedOptionError and names docs/compat.md`, () => {
      let error: unknown;
      try {
        build({ [key]: value });
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(UnsupportedOptionError);
      expect((error as Error).message).toContain(`"${key}"`);
      expect((error as Error).message).toContain('docs/compat.md');
    });
  }
});

describe('queue: package boundary', () => {
  test('no source file imports a Qelay client, a TCP socket or an embedded engine', () => {
    const dir = join(import.meta.dir, '../src');
    for (const file of readdirSync(dir).filter((name) => name.endsWith('.ts'))) {
      const source = readFileSync(join(dir, file), 'utf8');
      const imports = [...source.matchAll(/from '([^']+)'/g)].map((match) => match[1]!);
      for (const specifier of imports) {
        expect(specifier).not.toMatch(/^(qelay|@qelay\/)/);
        expect(specifier).not.toMatch(/^(node:)?(net|tls|dgram|http2?)$/);
        expect(specifier).not.toMatch(/(^|\/)(client|embedded)(\/|$)/);
      }
    }
  });
});
