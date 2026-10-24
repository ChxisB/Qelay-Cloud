import type { SourceVerification, SourceVerificationKind } from '@qelay-cloud/core';
import type { SourceRecord } from './inboundTypes';

type Time = number | string | bigint;

export interface SourceRow {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly verification: string;
  readonly verification_header: string | null;
  readonly verification_user: string | null;
  readonly secret_sealed: string | null;
  readonly secret_previous_until: Time | null;
  readonly rejected_dropped: Time;
  readonly created_by: string;
  readonly created_at: Time;
  readonly updated_at: Time;
}

export const SOURCE_COLUMNS = `id, name, enabled, verification, verification_header, verification_user, secret_sealed,
  secret_previous_until, rejected_dropped, created_by, created_at, updated_at`;

export const verificationOf = (row: SourceRow): SourceVerification => ({
  kind: row.verification as SourceVerificationKind,
  header: row.verification_header,
  username: row.verification_user,
});

export const sourceOf = (row: SourceRow): SourceRecord => ({
  id: row.id,
  name: row.name,
  enabled: row.enabled,
  verification: verificationOf(row),
  signed: row.secret_sealed !== null,
  previousSecretUntil:
    row.secret_previous_until === null ? null : Number(row.secret_previous_until),
  rejectedDropped: Number(row.rejected_dropped),
  createdBy: row.created_by,
  createdAt: Number(row.created_at),
  updatedAt: Number(row.updated_at),
});

/** Binds a sealed secret to its row, and apart from a webhook's: the same text sealed for another row does not open. */
export const sourceSecretContext = (namespace: string, id: string): string =>
  `source:${namespace}/${id}`;
