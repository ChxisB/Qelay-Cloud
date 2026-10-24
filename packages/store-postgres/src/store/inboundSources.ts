import {
  generateSourceSecret,
  generateSourceToken,
  hashSourceToken,
  MAX_SOURCES,
  sealSecret,
  UnsupportedOptionError,
  validateName,
  validateVerification,
} from '@qelay-cloud/core';
import type { TransactionSQL } from 'bun';
import {
  SourceInUseError,
  SourceLimitError,
  SourceNameTakenError,
  WebhookKeyError,
} from '../errors';
import type { StoreContext } from './context';
import type { SourceRow } from './inboundRows';
import { SOURCE_COLUMNS, sourceOf, sourceSecretContext } from './inboundRows';
import type { SourceIssued, SourcePatch, SourceRecord, SourceSpec } from './inboundTypes';
import { advisoryLockName } from './locks';
import { identifier } from './prepare';
import { runTransaction } from './retry';
import { checkSecret } from './webhookValidate';

/**
 * Inbound sources (migration 20, DESIGN.md D12 and D14): the operator's side of the public URLs a request can be posted to.
 * The request side is `inboundAccept.ts`. A source's URL token is shown once and only its hash is kept; its secret is sealed
 * with the webhook key like a webhook's, and bound to its row by `sourceSecretContext`.
 */

const MAX_CREATED_BY_CHARS = 200;
export const NO_KEY = 'source secrets need a webhook key; this store was given none';

const lock = (tx: TransactionSQL, ctx: StoreContext) =>
  tx`SELECT pg_advisory_xact_lock(hashtextextended(${advisoryLockName('sources', ctx.namespace)}, 0))`;

function requiredName(value: unknown): string {
  const name = validateName(value);
  if (name === null) throw new UnsupportedOptionError('name', 'is required');
  return name;
}

export async function readOne(
  tx: TransactionSQL,
  ctx: StoreContext,
  id: string
): Promise<SourceRecord | null> {
  const [row] = await tx.unsafe<SourceRow[]>(
    `SELECT ${SOURCE_COLUMNS} FROM qcloud_sources WHERE namespace = $1 AND id = $2`,
    [ctx.namespace, id]
  );
  return row ? sourceOf(row) : null;
}

async function assertNameFree(
  tx: TransactionSQL,
  ctx: StoreContext,
  name: string,
  exceptId: string | null
): Promise<void> {
  const [taken] = await tx<Array<{ id: string }>>`
    SELECT id FROM qcloud_sources
    WHERE namespace = ${ctx.namespace} AND name = ${name} AND id IS DISTINCT FROM ${exceptId}::text`;
  if (taken) throw new SourceNameTakenError(name);
}

/**
 * Registers a source and issues its URL token, and a secret when it verifies. Refused, with nothing written, at the
 * namespace's cap (`SourceLimitError`), for a name in use (`SourceNameTakenError`), or for a secret when the store has no
 * `webhookKey` to seal it with (`WebhookKeyError`).
 */
export async function createSource(
  ctx: StoreContext,
  spec: SourceSpec,
  createdBy: string
): Promise<SourceIssued> {
  const name = requiredName(spec.name);
  const verification = validateVerification(spec.verification);
  const owner = identifier('createdBy', createdBy).slice(0, MAX_CREATED_BY_CHARS);
  const given = checkSecret(spec.secret);
  const verifies = verification.kind !== 'none';
  if (!verifies && given !== null) {
    throw new UnsupportedOptionError('secret', 'a source with no verification has no secret');
  }
  if (verifies && ctx.webhookKey === null) throw new WebhookKeyError(NO_KEY);
  const token = generateSourceToken();
  const tokenHash = await hashSourceToken(token);
  const made = verifies && given === null ? generateSourceSecret() : null;
  const secret = given ?? made;
  return ctx.db.run('createSource', (sql) =>
    runTransaction(sql, async (tx) => {
      const now = await ctx.db.time.now(tx);
      await lock(tx, ctx);
      const [counted] = await tx<Array<{ n: number | string }>>`
        SELECT count(*) AS n FROM qcloud_sources WHERE namespace = ${ctx.namespace}`;
      if (Number(counted!.n) >= MAX_SOURCES) throw new SourceLimitError(MAX_SOURCES);
      await assertNameFree(tx, ctx, name, null);
      const id = ctx.nextId(now);
      const sealed =
        secret === null
          ? null
          : await sealSecret(secret, ctx.webhookKey!, sourceSecretContext(ctx.namespace, id));
      await tx.unsafe(
        `INSERT INTO qcloud_sources
           (namespace, id, name, token_hash, verification, verification_header, verification_user, secret_sealed,
            enabled, created_by, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11)`,
        [
          ctx.namespace,
          id,
          name,
          tokenHash,
          verification.kind,
          verification.header,
          verification.username,
          sealed,
          spec.enabled ?? true,
          owner,
          now,
        ]
      );
      return { ...(await readOne(tx, ctx, id))!, token, secret: made };
    })
  );
}

/** Every source of the namespace, oldest first. */
export async function listSources(ctx: StoreContext): Promise<SourceRecord[]> {
  return ctx.db.run('listSources', async (sql) => {
    const rows = await sql.unsafe<SourceRow[]>(
      `SELECT ${SOURCE_COLUMNS} FROM qcloud_sources WHERE namespace = $1 ORDER BY created_at, id`,
      [ctx.namespace]
    );
    return rows.map(sourceOf);
  });
}

export async function getSource(ctx: StoreContext, id: string): Promise<SourceRecord | null> {
  const key = identifier('id', id);
  return ctx.db.run('getSource', async (sql) => {
    const [row] = await sql.unsafe<SourceRow[]>(
      `SELECT ${SOURCE_COLUMNS} FROM qcloud_sources WHERE namespace = $1 AND id = $2`,
      [ctx.namespace, key]
    );
    return row ? sourceOf(row) : null;
  });
}

/** Renames a source or turns it on or off (`SourcePatch`). Null when there is no such source. */
export async function updateSource(
  ctx: StoreContext,
  id: string,
  patch: SourcePatch
): Promise<SourceRecord | null> {
  const key = identifier('id', id);
  if (patch.name === undefined && patch.enabled === undefined) {
    throw new UnsupportedOptionError('patch', 'name at least one field to change');
  }
  if (patch.enabled !== undefined && typeof patch.enabled !== 'boolean') {
    throw new UnsupportedOptionError('enabled', 'must be true or false');
  }
  const name = patch.name === undefined ? null : requiredName(patch.name);
  return ctx.db.run('updateSource', (sql) =>
    runTransaction(sql, async (tx) => {
      const now = await ctx.db.time.now(tx);
      await lock(tx, ctx);
      const [current] = await tx<Array<{ id: string }>>`
        SELECT id FROM qcloud_sources
        WHERE namespace = ${ctx.namespace} AND id = ${key} FOR NO KEY UPDATE`;
      if (!current) return null;
      if (name !== null) await assertNameFree(tx, ctx, name, key);
      await tx`
        UPDATE qcloud_sources
        SET name = coalesce(${name}::text, name), enabled = coalesce(${patch.enabled ?? null}::boolean, enabled),
            updated_at = ${now}
        WHERE namespace = ${ctx.namespace} AND id = ${key}`;
      return readOne(tx, ctx, key);
    })
  );
}

/**
 * Deletes a source and the requests it took. `SourceInUseError` while a route listens to it. False when there was none.
 * The row is locked first, which waits for a route being made on it, so the count is the one the delete meets.
 */
export async function deleteSource(ctx: StoreContext, id: string): Promise<boolean> {
  const key = identifier('id', id);
  return ctx.db.run('deleteSource', (sql) =>
    runTransaction(sql, async (tx) => {
      const [current] = await tx<Array<{ id: string }>>`
        SELECT id FROM qcloud_sources
        WHERE namespace = ${ctx.namespace} AND id = ${key} FOR UPDATE`;
      if (!current) return false;
      const [used] = await tx<Array<{ n: number | string }>>`
        SELECT count(*) AS n FROM qcloud_webhooks
        WHERE namespace = ${ctx.namespace} AND source_id = ${key}`;
      if (Number(used!.n) > 0) throw new SourceInUseError(Number(used!.n));
      await tx`DELETE FROM qcloud_sources WHERE namespace = ${ctx.namespace} AND id = ${key}`;
      return true;
    })
  );
}
