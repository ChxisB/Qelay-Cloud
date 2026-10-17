import { describe, expect, test } from 'bun:test';
import { describeTarget, resolveTarget, targetToSqlOptions } from '../src/connection/target';
import { ConnectionConfigError } from '../src/errors';

const message = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ConnectionConfigError);
    return (error as Error).message;
  }
  throw new Error('expected a ConnectionConfigError');
};

describe('connection target', () => {
  test('a url yields host, port, database and credentials', () => {
    const target = resolveTarget({ url: 'postgres://app:p%40ss@127.0.0.1:6543/jobs' });
    expect(target).toMatchObject({
      kind: 'tcp',
      host: '127.0.0.1',
      port: 6543,
      database: 'jobs',
      username: 'app',
      password: 'p@ss',
      tls: false,
    });
  });

  test('discrete options override the url, and the port defaults to 5432', () => {
    const target = resolveTarget({
      url: 'postgres://app:secret@localhost/jobs',
      database: 'other',
      username: 'svc',
      port: 6000,
    });
    expect(target).toMatchObject({ database: 'other', username: 'svc', port: 6000 });
    expect(resolveTarget({ url: 'postgres://a:b@localhost/d' })).toMatchObject({ port: 5432 });
  });

  test('a loopback host may leave tls out; any other host must choose', () => {
    for (const host of ['localhost', '127.0.0.1', '127.8.8.8', '::1']) {
      expect(resolveTarget({ host, database: 'd', username: 'u' })).toMatchObject({ tls: false });
    }
    expect(message(() => resolveTarget({ url: 'postgres://u:p@db.internal/d' }))).toMatch(
      /tls must be chosen for the non-local host db\.internal/
    );
    for (const tls of [false, 'unverified', { ca: 'PEM' }] as const) {
      expect(resolveTarget({ url: 'postgres://u:p@db.internal/d', tls })).toMatchObject({ tls });
    }
  });

  test('tls maps to the driver: verified with a CA, encrypted-only when unverified, off when false', () => {
    const base = { url: 'postgres://u:p@db.internal/d' };
    expect(targetToSqlOptions(resolveTarget({ ...base, tls: false }))).toMatchObject({
      tls: false,
    });
    expect(targetToSqlOptions(resolveTarget({ ...base, tls: 'unverified' }))).toMatchObject({
      tls: true,
    });
    expect(
      targetToSqlOptions(resolveTarget({ ...base, tls: { ca: 'PEM', serverName: 'db.example' } }))
    ).toMatchObject({ tls: { ca: 'PEM', serverName: 'db.example' } });
  });

  test('libpq host parameters are refused, because Bun.SQL reads them as a TCP host', () => {
    const text = message(() =>
      resolveTarget({ url: 'postgres://u:p@localhost/d?host=%2Fcloudsql%2Fx' })
    );
    expect(text).toMatch(/"host" is the libpq way/);
    expect(text).toMatch(/socketPath/);
  });

  test('ssl url parameters are refused, because sslmode=require does not verify', () => {
    for (const key of ['sslmode', 'ssl', 'sslrootcert']) {
      expect(
        message(() => resolveTarget({ url: `postgres://u:p@db.internal/d?${key}=require` }))
      ).toMatch(/cannot be trusted/);
    }
    expect(
      message(() => resolveTarget({ url: 'postgres://u:p@localhost/d?connect_timeout=3' }))
    ).toMatch(/not supported/);
  });

  test('a unix socket target takes a path, no host and no tls', () => {
    const target = resolveTarget({
      socketPath: '/cloudsql/project:region:instance',
      database: 'd',
      username: 'u',
    });
    expect(target).toMatchObject({
      kind: 'socket',
      path: '/cloudsql/project:region:instance',
      tls: false,
    });
    expect(targetToSqlOptions(target)).toMatchObject({ path: '/cloudsql/project:region:instance' });
    expect(targetToSqlOptions(target)).not.toHaveProperty('hostname');
    expect(
      message(() => resolveTarget({ socketPath: '/s', host: 'x', database: 'd', username: 'u' }))
    ).toMatch(/either a host or a socketPath/);
    expect(
      message(() =>
        resolveTarget({ socketPath: '/s', tls: 'unverified', database: 'd', username: 'u' })
      )
    ).toMatch(/does not apply to a unix socket/);
  });

  test('missing pieces and bad values name the problem', () => {
    expect(message(() => resolveTarget({ host: 'localhost', username: 'u' }))).toMatch(
      /database name/
    );
    expect(message(() => resolveTarget({ host: 'localhost', database: 'd' }))).toMatch(/user name/);
    expect(message(() => resolveTarget({ database: 'd', username: 'u' }))).toMatch(
      /host or a socketPath/
    );
    expect(
      message(() =>
        resolveTarget({ host: 'localhost', port: 70_000, database: 'd', username: 'u' })
      )
    ).toMatch(/1-65535/);
    expect(message(() => resolveTarget({ url: 'mysql://u:p@localhost/d' }))).toMatch(
      /must start with postgres/
    );
  });

  test('no message echoes the password, not even for a url that does not parse', () => {
    const password = 'hunter2-do-not-leak';
    const texts = [
      message(() => resolveTarget({ url: `not a url ${password}` })),
      message(() => resolveTarget({ url: `postgres://u:${password}@db.internal/d` })),
      message(() =>
        resolveTarget({ url: `postgres://u:${password}@db.internal/d?sslmode=require` })
      ),
      message(() => resolveTarget({ url: `mysql://u:${password}@localhost/d` })),
      message(() => resolveTarget({ url: `postgres://u:${password}@localhost/d?host=/tmp` })),
    ];
    for (const text of texts) expect(text).not.toContain(password);
    expect(
      describeTarget(resolveTarget({ url: `postgres://u:${password}@localhost:5433/d` }))
    ).toBe('u@localhost:5433/d');
  });

  test('a password may be a function that the driver calls per connection', async () => {
    let calls = 0;
    const target = resolveTarget({
      host: 'localhost',
      database: 'd',
      username: 'u',
      password: async () => `token-${++calls}`,
    });
    const options = targetToSqlOptions(target) as { password: () => Promise<string> };
    expect(typeof options.password).toBe('function');
    expect(await options.password()).toBe('token-1');
    expect(await options.password()).toBe('token-2');
  });
});
