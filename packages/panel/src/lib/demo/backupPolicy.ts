import type { BackupPolicy, BackupPolicyInput } from '../ops/types';
import type { Json } from './shared';

/**
 * The Backups page in demo mode: the demo deployment says its backups are its own tooling, and a save
 * changes the answer for the rest of the session. Nothing leaves the browser.
 */
let policy: BackupPolicy | null = {
  mechanism: 'external',
  tool: 'pgBackRest',
  location: 'gs://acme-qelay-backups/prod',
  updatedBy: 'demo',
  updatedAt: Date.now() - 3 * 24 * 3_600_000,
};

/** `GET` and `PUT /backup-policy` for the demo fetch shim. A body the server would refuse is a 400. */
export function demoBackupPolicyReply(
  method: string,
  body: unknown
): { body: Json; status: number } {
  if (method !== 'PUT') return { body: { ok: true, data: { policy } }, status: 200 };
  const input = body as Partial<BackupPolicyInput> | undefined;
  const mechanism = input?.mechanism;
  const tool = input?.tool?.trim() || null;
  const location = input?.location?.trim() || null;
  const fits =
    mechanism === 'external'
      ? tool !== null
      : (mechanism === 'provider' || mechanism === 'none') && tool === null && location === null;
  if (!fits || !mechanism) {
    return {
      body: {
        ok: false,
        error: { code: 'invalid_request', message: 'The declaration does not fit.' },
      },
      status: 400,
    };
  }
  policy = {
    mechanism,
    tool,
    location: mechanism === 'external' ? location : null,
    updatedBy: 'demo',
    updatedAt: Date.now(),
  };
  return { body: { ok: true, data: { policy } }, status: 200 };
}
