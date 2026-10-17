import type { SQL } from 'bun';
import { ConnectionConfigError } from '../errors';

/**
 * How the connection is secured. `Bun.SQL` 1.4.2 sends plaintext unless asked, and `tls: true` or
 * `sslmode=require` encrypt without verifying the server, so the options here are explicit:
 *
 * - `{ ca }`: encrypted and verified against `ca` (and the host name, or `serverName`).
 * - `'unverified'`: encrypted, server identity not checked. For a private network you accept as is.
 * - `false`: plaintext, said out loud.
 *
 * Leaving it out is allowed only for a loopback host or a unix socket (the Cloud SQL socket is
 * encrypted by the connector). Any other host must choose.
 */
export type TlsOption =
  | false
  | 'unverified'
  | { readonly ca: string; readonly serverName?: string };

export type PasswordSource = string | (() => string | Promise<string>);

export interface TargetOptions {
  /** `postgres://user:password@host:port/database`. Discrete fields below override its parts. */
  readonly url?: string;
  readonly host?: string;
  readonly port?: number;
  readonly database?: string;
  readonly username?: string;
  /** A function is called for each new connection, so an IAM token can be minted fresh. */
  readonly password?: PasswordSource;
  /** A unix socket directory or file, for example `/cloudsql/<project:region:instance>` on Cloud Run. */
  readonly socketPath?: string;
  readonly tls?: TlsOption;
}

export type ResolvedTarget =
  | {
      readonly kind: 'tcp';
      readonly host: string;
      readonly port: number;
      readonly database: string;
      readonly username: string;
      readonly password: PasswordSource | undefined;
      readonly tls: TlsOption;
    }
  | {
      readonly kind: 'socket';
      readonly path: string;
      readonly database: string;
      readonly username: string;
      readonly password: PasswordSource | undefined;
      readonly tls: false;
    };

const LIBPQ_PARAMETERS = new Set(['host', 'hostaddr']);
const SSL_PARAMETERS = new Set(['ssl', 'sslmode', 'sslrootcert', 'sslcert', 'sslkey']);

/** Parses and validates the target. Pure: opens nothing, and no message carries a password. */
export function resolveTarget(options: TargetOptions): ResolvedTarget {
  const fromUrl = options.url === undefined ? {} : parseUrl(options.url);
  const database = options.database ?? fromUrl.database;
  const username = options.username ?? fromUrl.username;
  const password = options.password ?? fromUrl.password;
  if (!database) throw new ConnectionConfigError('The database name is required');
  if (!username) throw new ConnectionConfigError('The database user name is required');

  if (options.socketPath !== undefined) {
    if (options.host !== undefined || fromUrl.host !== undefined) {
      throw new ConnectionConfigError('Set either a host or a socketPath, not both');
    }
    if (options.tls !== undefined) {
      throw new ConnectionConfigError(
        'tls does not apply to a unix socket: the connector that owns the socket encrypts it'
      );
    }
    if (!options.socketPath) throw new ConnectionConfigError('socketPath is empty');
    return { kind: 'socket', path: options.socketPath, database, username, password, tls: false };
  }

  const host = options.host ?? fromUrl.host;
  if (!host) throw new ConnectionConfigError('A database host or a socketPath is required');
  const port = options.port ?? fromUrl.port ?? 5432;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new ConnectionConfigError(`The database port must be 1-65535, not ${port}`);
  }
  const tls = options.tls ?? (isLoopback(host) ? false : undefined);
  if (tls === undefined) {
    throw new ConnectionConfigError(
      `tls must be chosen for the non-local host ${host}: pass { ca } to verify the server, ` +
        "'unverified' to encrypt without verifying, or false to accept plaintext"
    );
  }
  return { kind: 'tcp', host, port, database, username, password, tls };
}

/** The driver options for one connection pool to `target`. The caller adds sizes and timeouts. */
export function targetToSqlOptions(target: ResolvedTarget): SQL.Options {
  const base = {
    adapter: 'postgres' as const,
    database: target.database,
    username: target.username,
    ...(target.password === undefined ? {} : { password: target.password }),
  };
  if (target.kind === 'socket') return { ...base, path: target.path };
  return {
    ...base,
    hostname: target.host,
    port: target.port,
    tls: target.tls === false ? false : target.tls === 'unverified' ? true : { ...target.tls },
  };
}

/** `user@host:port/database`, safe to log: no password, no token. */
export function describeTarget(target: ResolvedTarget): string {
  const where = target.kind === 'socket' ? `unix:${target.path}` : `${target.host}:${target.port}`;
  return `${target.username}@${where}/${target.database}`;
}

interface UrlParts {
  host?: string;
  port?: number;
  database?: string;
  username?: string;
  password?: string;
}

function parseUrl(value: string): UrlParts {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    // The message of the URL parser can echo the input, and the input holds a password.
    throw new ConnectionConfigError('The database url is not a valid URL');
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new ConnectionConfigError(
      `The database url must start with postgres://, not ${url.protocol}//`
    );
  }
  for (const key of new Set(url.searchParams.keys())) {
    if (LIBPQ_PARAMETERS.has(key)) {
      throw new ConnectionConfigError(
        `The url parameter "${key}" is the libpq way to name a host or a socket directory. Bun.SQL ` +
          'ignores it and reads the url host instead, silently. Use the socketPath option for a unix socket.'
      );
    }
    if (SSL_PARAMETERS.has(key)) {
      throw new ConnectionConfigError(
        `The url parameter "${key}" cannot be trusted: Bun.SQL encrypts without verifying for sslmode=require. ` +
          'Use the tls option.'
      );
    }
    throw new ConnectionConfigError(
      `The url parameter "${key}" is not supported. Use the typed connection options.`
    );
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  return {
    ...(url.hostname ? { host: stripBrackets(url.hostname) } : {}),
    ...(url.port ? { port: Number(url.port) } : {}),
    ...(database ? { database } : {}),
    ...(url.username ? { username: decodeURIComponent(url.username) } : {}),
    ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
  };
}

function stripBrackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

function isLoopback(host: string): boolean {
  return host === 'localhost' || host === '::1' || /^127(\.\d{1,3}){3}$/.test(host);
}
