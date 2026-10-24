import {
  generateSourceSecret,
  generateSourceToken,
  hashSourceToken,
  openSecret,
  sealSecret,
  UnsupportedOptionError,
  WEBHOOK_SECRET_GRACE_MS,
} from '@qelay-cloud/core';
import { WebhookKeyError } from '../errors';
import type { StoreContext } from './context';
import type { SourceRow } from './inboundRows';
import { sourceSecretContext, verificationOf } from './inboundRows';
import { NO_KEY, readOne } from './inboundSources';
import type { SourceAuth, SourceIssued } from './inboundTypes';
import { identifier } from './prepare';
import { runTransaction } from './retry';
import { checkSecret } from './webhookValidate';

/** Credentials of a source (migration 20): rotating its secret and its URL token, and finding it by the token. */

const TOKEN_SHAPE = /^qin_[A-Za-z0-9_-]{43}$/u;

/**
 * Gives the source a new secret (the one given, or a generated one returned once). The old one keeps verifying beside it
 * for `WEBHOOK_SECRET_GRACE_MS`, so the sender can switch over without losing a request. Null when there is no such
 * source; `UnsupportedOptionError` for one that does not verify; `WebhookKeyError` without a `webhookKey`.
 */
export async function rotateSourceSecret(
  ctx: StoreContext,
  id: string,
  secret?: string | null
): Promise<SourceIssued | null> {
  const key = identifier('id', id);
  const given = checkSecret(secret);
  if (ctx.webhookKey === null) throw new WebhookKeyError(NO_KEY);
  const made = given === null ? generateSourceSecret() : null;
  const sealed = await sealSecret(
    given ?? made!,
    ctx.webhookKey,
    sourceSecretContext(ctx.namespace, key)
  );
  return ctx.db.run('rotateSourceSecret', (sql) =>
    runTransaction(sql, async (tx) => {
      const now = await ctx.db.time.now(tx);
      const [current] = await tx<Array<{ verification: string }>>`
        SELECT verification FROM qcloud_sources
        WHERE namespace = ${ctx.namespace} AND id = ${key} FOR NO KEY UPDATE`;
      if (!current) return null;
      if (current.verification === 'none') {
        throw new UnsupportedOptionError('secret', 'a source with no verification has no secret');
      }
      await tx`
        UPDATE qcloud_sources
        SET secret_previous_sealed = secret_sealed,
            secret_previous_until = CASE WHEN secret_sealed IS NULL THEN NULL ELSE ${now + WEBHOOK_SECRET_GRACE_MS}::bigint END,
            secret_sealed = ${sealed}, updated_at = ${now}
        WHERE namespace = ${ctx.namespace} AND id = ${key}`;
      return { ...(await readOne(tx, ctx, key))!, token: null, secret: made };
    })
  );
}

/**
 * Gives the source a new URL token, returned once. The old URL stops working at once: a leaked URL is fixed here, because a
 * source with routes cannot be deleted. Null when there is no such source.
 */
export async function rotateSourceToken(
  ctx: StoreContext,
  id: string
): Promise<SourceIssued | null> {
  const key = identifier('id', id);
  const token = generateSourceToken();
  const tokenHash = await hashSourceToken(token);
  return ctx.db.run('rotateSourceToken', (sql) =>
    runTransaction(sql, async (tx) => {
      const now = await ctx.db.time.now(tx);
      const rows = await tx<Array<{ id: string }>>`
        UPDATE qcloud_sources SET token_hash = ${tokenHash}, updated_at = ${now}
        WHERE namespace = ${ctx.namespace} AND id = ${key} RETURNING id`;
      if (rows.length === 0) return null;
      return { ...(await readOne(tx, ctx, key))!, token, secret: null };
    })
  );
}

/**
 * The source a URL token belongs to, with its secret opened, for the ingest to judge a request by. Null for a token that is
 * not one of ours, or that no source has (also after `rotateToken`). A disabled source is returned: the ingest answers it
 * as it would a missing one.
 */
export async function findSourceByToken(
  ctx: StoreContext,
  token: string
): Promise<SourceAuth | null> {
  if (!TOKEN_SHAPE.test(token)) return null;
  const tokenHash = await hashSourceToken(token);
  const found = await ctx.db.run('findSourceByToken', async (sql) => {
    const now = await ctx.db.time.now(sql);
    const [row] = await sql<Array<SourceRow & { secret_previous_sealed: string | null }>>`
      SELECT id, name, enabled, verification, verification_header, verification_user, secret_sealed,
             secret_previous_sealed, secret_previous_until, rejected_dropped, created_by, created_at, updated_at
      FROM qcloud_sources WHERE namespace = ${ctx.namespace} AND token_hash = ${tokenHash}`;
    return row ? { row, now } : null;
  });
  if (found === null) return null;
  const { row, now } = found;
  // Opening a secret is CPU work, so it happens after the read and holds no connection.
  const open = (sealed: string): Promise<string | null> =>
    ctx.webhookKey === null
      ? Promise.resolve(null)
      : openSecret(sealed, ctx.webhookKey, sourceSecretContext(ctx.namespace, row.id));
  const secret = row.secret_sealed === null ? null : await open(row.secret_sealed);
  const previous =
    row.secret_previous_sealed !== null && Number(row.secret_previous_until) > now
      ? await open(row.secret_previous_sealed)
      : null;
  return {
    id: row.id,
    enabled: row.enabled,
    verification: verificationOf(row),
    secret,
    previousSecret: previous,
    secretUnreadable: row.secret_sealed !== null && secret === null,
  };
}
