import {
  isWebhookDestination,
  MAX_DESTINATIONS,
  UnsupportedOptionError,
  validateName,
} from '@qelay-cloud/core';
import type { WebhookDestination } from '@qelay-cloud/core';
import type { TransactionSQL } from 'bun';
import { DestinationInUseError, DestinationLimitError, DestinationNameTakenError } from '../errors';
import type { StoreContext } from './context';
import { advisoryLockName } from './locks';
import { identifier } from './prepare';
import { runTransaction } from './retry';
import type {
  DestinationPatch,
  DestinationRecord,
  DestinationSpec,
} from './webhookDestinationTypes';
import type { WebhookSpec } from './webhookTypes';
import { checkAddress } from './webhookValidate';

/**
 * Saved destinations (migration 19): a named address that webhooks are made from. A webhook keeps `destination_id` and
 * its own copy of the address, so the sender never looks a destination up; changing a destination rewrites the copies in
 * the same transaction. Every write takes the namespace's `webhooks` advisory lock, the one a webhook save takes, so a
 * count or a name check cannot be raced by another save.
 */

type Time = number | string | bigint;
interface Row {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly url: string | null;
  readonly target: string | null;
  readonly created_by: string;
  readonly created_at: Time;
  readonly updated_at: Time;
  readonly connections: Time;
}

const MAX_CREATED_BY_CHARS = 200;
const COLUMNS = `d.id, d.name, d.kind, d.url, d.target, d.created_by, d.created_at, d.updated_at,
  (SELECT count(*) FROM qcloud_webhooks w
   WHERE w.namespace = d.namespace AND w.destination_id = d.id) AS connections`;

const recordOf = (row: Row): DestinationRecord => ({
  id: row.id,
  name: row.name,
  kind: row.kind as WebhookDestination,
  url: row.url,
  target: row.target,
  connections: Number(row.connections),
  createdBy: row.created_by,
  createdAt: Number(row.created_at),
  updatedAt: Number(row.updated_at),
});

const lock = (tx: TransactionSQL, ctx: StoreContext) =>
  tx`SELECT pg_advisory_xact_lock(hashtextextended(${advisoryLockName('webhooks', ctx.namespace)}, 0))`;

const ONE = `SELECT ${COLUMNS} FROM qcloud_webhook_destinations d WHERE d.namespace = $1 AND d.id = $2`;

async function readOne(
  tx: TransactionSQL,
  ctx: StoreContext,
  id: string
): Promise<DestinationRecord | null> {
  const [row] = await tx.unsafe<Row[]>(ONE, [ctx.namespace, id]);
  return row ? recordOf(row) : null;
}

function checkedName(value: unknown): string {
  const name = validateName(value);
  if (name === null) throw new UnsupportedOptionError('name', 'is required');
  return name;
}

async function assertNameFree(
  tx: TransactionSQL,
  ctx: StoreContext,
  name: string,
  ownId: string | null
): Promise<void> {
  const [taken] = await tx<Array<{ id: string }>>`
    SELECT id FROM qcloud_webhook_destinations
    WHERE namespace = ${ctx.namespace} AND name = ${name} AND id IS DISTINCT FROM ${ownId}`;
  if (taken) throw new DestinationNameTakenError(name);
}

/**
 * Saves a destination. Refused, with nothing written, for a name another one has (`DestinationNameTakenError`), at
 * `MAX_DESTINATIONS` (`DestinationLimitError`) or for a name or address that does not validate (`UnsupportedOptionError`).
 */
export async function createDestination(
  ctx: StoreContext,
  spec: DestinationSpec,
  createdBy: string
): Promise<DestinationRecord> {
  const name = checkedName(spec.name);
  if (!isWebhookDestination(spec.kind)) {
    throw new UnsupportedOptionError('kind', 'must be http or queue');
  }
  const address = checkAddress(spec.kind, spec.url, spec.target);
  const owner = identifier('createdBy', createdBy).slice(0, MAX_CREATED_BY_CHARS);
  return ctx.db.run('createDestination', (sql) =>
    runTransaction(sql, async (tx) => {
      const now = await ctx.db.time.now(tx);
      await lock(tx, ctx);
      const [counted] = await tx<Array<{ n: number | string }>>`
        SELECT count(*) AS n FROM qcloud_webhook_destinations WHERE namespace = ${ctx.namespace}`;
      if (Number(counted!.n) >= MAX_DESTINATIONS) throw new DestinationLimitError(MAX_DESTINATIONS);
      await assertNameFree(tx, ctx, name, null);
      const id = ctx.nextId(now);
      await tx.unsafe(
        `INSERT INTO qcloud_webhook_destinations
           (namespace, id, name, kind, url, target, created_by, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)`,
        [
          ctx.namespace,
          id,
          name,
          address.destination,
          address.destination === 'http' ? address.url : null,
          address.target,
          owner,
          now,
        ]
      );
      return (await readOne(tx, ctx, id))!;
    })
  );
}

/** Every destination of the namespace, oldest first, with how many webhooks use it. */
export async function listDestinations(ctx: StoreContext): Promise<DestinationRecord[]> {
  return ctx.db.run('listDestinations', async (sql) => {
    const rows = await sql.unsafe<Row[]>(
      `SELECT ${COLUMNS} FROM qcloud_webhook_destinations d
       WHERE d.namespace = $1 ORDER BY d.created_at, d.id`,
      [ctx.namespace]
    );
    return rows.map(recordOf);
  });
}

export async function getDestination(
  ctx: StoreContext,
  id: string
): Promise<DestinationRecord | null> {
  const key = identifier('id', id);
  return ctx.db.run('getDestination', async (sql) => {
    const [row] = await sql.unsafe<Row[]>(ONE, [ctx.namespace, key]);
    return row ? recordOf(row) : null;
  });
}

/**
 * Renames a destination or moves its address. A new address is copied to every webhook made from it in the same
 * transaction. Null when there is no such destination.
 */
export async function updateDestination(
  ctx: StoreContext,
  id: string,
  patch: DestinationPatch
): Promise<DestinationRecord | null> {
  const key = identifier('id', id);
  if (patch.name === undefined && patch.url === undefined && patch.target === undefined) {
    throw new UnsupportedOptionError('patch', 'name at least one field to change');
  }
  const name = patch.name === undefined ? null : checkedName(patch.name);
  return ctx.db.run('updateDestination', (sql) =>
    runTransaction(sql, async (tx) => {
      const now = await ctx.db.time.now(tx);
      await lock(tx, ctx);
      const [row] = await tx<Array<{ kind: string; url: string | null; target: string | null }>>`
        SELECT kind, url, target FROM qcloud_webhook_destinations
        WHERE namespace = ${ctx.namespace} AND id = ${key} FOR NO KEY UPDATE`;
      if (!row) return null;
      // The kind is fixed, so an address key of the other kind is refused by the same check as at creation.
      const address = checkAddress(row.kind, patch.url ?? row.url, patch.target ?? row.target);
      if (name !== null) await assertNameFree(tx, ctx, name, key);
      await tx.unsafe(
        `UPDATE qcloud_webhook_destinations
         SET name = coalesce($3, name), url = $4, target = $5, updated_at = $6
         WHERE namespace = $1 AND id = $2`,
        [
          ctx.namespace,
          key,
          name,
          address.destination === 'http' ? address.url : null,
          address.target,
          now,
        ]
      );
      if (patch.url !== undefined || patch.target !== undefined) {
        await tx.unsafe(
          `UPDATE qcloud_webhooks SET url = $3, target = $4 WHERE namespace = $1 AND destination_id = $2`,
          [ctx.namespace, key, address.url, address.target]
        );
      }
      return readOne(tx, ctx, key);
    })
  );
}

/** Removes a destination; false when there was none. Refused while a webhook is made from it (`DestinationInUseError`). */
export async function deleteDestination(ctx: StoreContext, id: string): Promise<boolean> {
  const key = identifier('id', id);
  return ctx.db.run('deleteDestination', (sql) =>
    runTransaction(sql, async (tx) => {
      await lock(tx, ctx);
      const [used] = await tx<Array<{ n: number | string }>>`
        SELECT count(*) AS n FROM qcloud_webhooks
        WHERE namespace = ${ctx.namespace} AND destination_id = ${key}`;
      if (Number(used!.n) > 0) throw new DestinationInUseError(Number(used!.n));
      const rows = await tx<Array<{ id: string }>>`
        DELETE FROM qcloud_webhook_destinations
        WHERE namespace = ${ctx.namespace} AND id = ${key} RETURNING id`;
      return rows.length > 0;
    })
  );
}

/**
 * The spec of a webhook made from a destination: the address is the destination's, read and held (KEY SHARE: a removal
 * waits for the webhook's insert) in the creating transaction. The spec names the destination or an address, not both.
 */
export async function specFromDestination(
  tx: TransactionSQL,
  ctx: StoreContext,
  spec: WebhookSpec,
  destinationId: string
): Promise<WebhookSpec> {
  if (spec.destination != null || spec.url != null || spec.target != null) {
    throw new UnsupportedOptionError(
      'destinationId',
      'the address comes from the destination: give destinationId or the address, not both'
    );
  }
  const [found] = await tx<Array<{ kind: string; url: string | null; target: string | null }>>`
    SELECT kind, url, target FROM qcloud_webhook_destinations
    WHERE namespace = ${ctx.namespace} AND id = ${destinationId} FOR KEY SHARE`;
  if (!found) throw new UnsupportedOptionError('destinationId', 'no such destination');
  return {
    ...spec,
    destination: found.kind as WebhookDestination,
    ...(found.url === null ? {} : { url: found.url }),
    target: found.target,
  };
}
