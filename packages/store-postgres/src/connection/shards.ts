import { UnsupportedOptionError } from '@qelay-cloud/core';
import type { DatabaseOptions } from './connect';
import type { DatabaseEnvOptions } from './env';
import { databaseOptionsFromEnv } from './env';

type Env = Readonly<Record<string, string | undefined>>;

const SHARD_NAME = /^[a-z][a-z0-9]*$/;

/** The variables that hold a shard's connection string: credentials, so a log line must never show them. */
export const SHARD_SECRET_VARIABLE = /^QCLOUD_SHARD_[A-Z0-9]+_DATABASE_(LISTEN_)?URL$/;

function checkShardName(shard: string, where: string): void {
  if (!SHARD_NAME.test(shard)) {
    throw new UnsupportedOptionError(
      where,
      `names the shard "${shard}": a shard name is lower-case letters and digits, starting with a letter`
    );
  }
}

/**
 * Which database holds a namespace. Every table is scoped by namespace and a namespace never spans
 * databases, so this table is the whole routing layer: the SDK, the Control API and the tick each
 * look their namespace up here and open that database. A namespace moves only by an edit to the
 * map (and a copy of its rows), never because a hash changed when a shard was added.
 */
export class ShardMap {
  /** namespace → shard name. */
  readonly namespaces: ReadonlyMap<string, string>;
  readonly #databaseOf: (shard: string) => DatabaseOptions;

  private constructor(
    namespaces: ReadonlyMap<string, string>,
    databaseOf: (shard: string) => DatabaseOptions
  ) {
    this.namespaces = namespaces;
    this.#databaseOf = databaseOf;
  }

  /** A map from objects: `{ namespaces: { acme: 'a' }, shards: { a: { url } } }`. */
  static of(spec: {
    readonly namespaces: Readonly<Record<string, string>>;
    readonly shards: Readonly<Record<string, DatabaseOptions>>;
  }): ShardMap {
    const shards = new Map(Object.entries(spec.shards));
    for (const shard of shards.keys()) checkShardName(shard, 'shards');
    for (const [namespace, shard] of Object.entries(spec.namespaces)) {
      if (!shards.has(shard)) {
        throw new UnsupportedOptionError(
          'shards',
          `namespace "${namespace}" is on shard "${shard}", which has no database`
        );
      }
    }
    return new ShardMap(new Map(Object.entries(spec.namespaces)), (shard) => shards.get(shard)!);
  }

  /**
   * The map a process reads from its environment, or null when `QCLOUD_SHARDS` is unset (one
   * database, as before). `QCLOUD_SHARDS=acme=a,globex=b` puts namespaces on shards, and shard `a`
   * is reached through `QCLOUD_SHARD_A_DATABASE_URL`, with every other `QCLOUD_DATABASE_*` setting
   * a default that `QCLOUD_SHARD_A_DATABASE_*` overrides. A shard's variables are read only when a
   * process opens that shard, so an API for one namespace holds one shard's credentials.
   */
  static fromEnv(env: Env, options: DatabaseEnvOptions): ShardMap | null {
    const raw = env.QCLOUD_SHARDS;
    if (raw === undefined || raw === '') return null;
    for (const name of ['QCLOUD_DATABASE_URL', 'QCLOUD_DATABASE_LISTEN_URL']) {
      if (env[name]) {
        throw new UnsupportedOptionError(
          name,
          'conflicts with QCLOUD_SHARDS: give each shard its own QCLOUD_SHARD_<NAME>_DATABASE_URL'
        );
      }
    }
    const namespaces = new Map<string, string>();
    for (const entry of raw.split(',')) {
      const [namespace = '', shard = '', ...rest] = entry.trim().split('=');
      if (namespace === '' || shard === '' || rest.length > 0) {
        throw new UnsupportedOptionError(
          'QCLOUD_SHARDS',
          'must be namespace=shard pairs, comma separated'
        );
      }
      checkShardName(shard, 'QCLOUD_SHARDS');
      if (namespaces.has(namespace)) {
        throw new UnsupportedOptionError('QCLOUD_SHARDS', `lists namespace "${namespace}" twice`);
      }
      namespaces.set(namespace, shard);
    }
    return new ShardMap(namespaces, (shard) => {
      const prefix = `QCLOUD_SHARD_${shard.toUpperCase()}_`;
      const own = Object.entries(env)
        .filter(([name]) => name.startsWith(prefix))
        .map(([name, value]) => [`QCLOUD_${name.slice(prefix.length)}`, value] as const);
      if (!own.some(([name, value]) => name === 'QCLOUD_DATABASE_URL' && value)) {
        throw new UnsupportedOptionError(
          `${prefix}DATABASE_URL`,
          `is required: ${options.purpose}`
        );
      }
      return databaseOptionsFromEnv({ ...env, ...Object.fromEntries(own) }, options);
    });
  }

  /** The database that holds `namespace`. A namespace the map does not list is refused, not guessed. */
  databaseFor(namespace: string): DatabaseOptions {
    const shard = this.namespaces.get(namespace);
    if (shard === undefined) {
      throw new UnsupportedOptionError(
        'namespace',
        `"${namespace}" is not in the shard map: add it, so its data has one home`
      );
    }
    return this.#databaseOf(shard);
  }

  /** The shards that hold a namespace, each once. */
  get shards(): string[] {
    return [...new Set(this.namespaces.values())];
  }

  /** The database of a shard from `shards`. */
  databaseOfShard(shard: string): DatabaseOptions {
    return this.#databaseOf(shard);
  }

  namespacesOf(shard: string): string[] {
    return [...this.namespaces].filter(([, on]) => on === shard).map(([namespace]) => namespace);
  }
}

/** The database a process serving `namespace` opens: its shard's when `QCLOUD_SHARDS` is set, else the one database. */
export function databaseOptionsForNamespace(
  env: Env,
  namespace: string,
  options: DatabaseEnvOptions
): DatabaseOptions {
  return (
    ShardMap.fromEnv(env, options)?.databaseFor(namespace) ?? databaseOptionsFromEnv(env, options)
  );
}
