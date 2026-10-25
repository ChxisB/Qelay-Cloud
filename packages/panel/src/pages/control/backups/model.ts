import type { BackupMechanism, BackupPolicy, BackupPolicyInput } from '@/lib/ops/types';

/** The server's bounds (`MAX_BACKUP_TOOL_CHARS`, `MAX_BACKUP_LOCATION_CHARS`); the panel only says so earlier. */
export const MAX_TOOL_CHARS = 200;
export const MAX_LOCATION_CHARS = 500;

export interface MechanismInfo {
  readonly value: BackupMechanism;
  readonly title: string;
  readonly hint: string;
}

/** The three answers, in the order they are offered. Qelay runs none of them. */
export const MECHANISMS: readonly MechanismInfo[] = [
  {
    value: 'provider',
    title: 'The database service',
    hint: 'Managed backups: Cloud SQL automated backups, RDS snapshots, point-in-time recovery.',
  },
  {
    value: 'external',
    title: 'Our own tooling',
    hint: 'Something you run outside Qelay: pgBackRest, Barman, WAL-G, a scheduled pg_dump.',
  },
  {
    value: 'none',
    title: 'Nothing',
    hint: 'This database is not backed up. The Deployment page keeps warning about it.',
  },
];

/** What the form holds. `mechanism` is null until somebody picks one, so an undeclared database never saves by accident. */
export interface Draft {
  mechanism: BackupMechanism | null;
  tool: string;
  location: string;
}

export const draftFrom = (policy: BackupPolicy | null): Draft => ({
  mechanism: policy?.mechanism ?? null,
  tool: policy?.tool ?? '',
  location: policy?.location ?? '',
});

/** What is wrong with the draft, field by field. Empty when it can be saved. */
export function draftProblems(draft: Draft): {
  mechanism?: string;
  tool?: string;
  location?: string;
} {
  if (draft.mechanism === null) return { mechanism: 'Pick one.' };
  if (draft.mechanism !== 'external') return {};
  const problems: { tool?: string; location?: string } = {};
  if (draft.tool.trim() === '') problems.tool = 'Name the tool that takes the backups.';
  else if (draft.tool.trim().length > MAX_TOOL_CHARS) {
    problems.tool = `At most ${MAX_TOOL_CHARS} characters.`;
  }
  if (draft.location.trim().length > MAX_LOCATION_CHARS) {
    problems.location = `At most ${MAX_LOCATION_CHARS} characters.`;
  }
  return problems;
}

/** The body for `PUT /backup-policy`, or null while the draft does not fit. Only `external` carries a tool or a location. */
export function inputFrom(draft: Draft): BackupPolicyInput | null {
  if (draft.mechanism === null || Object.keys(draftProblems(draft)).length > 0) return null;
  if (draft.mechanism !== 'external') return { mechanism: draft.mechanism };
  return {
    mechanism: 'external',
    tool: draft.tool.trim(),
    location: draft.location.trim() || null,
  };
}

/** Whether saving the draft would change what the server holds. */
export function isChanged(draft: Draft, saved: BackupPolicy | null): boolean {
  const input = inputFrom(draft);
  if (input === null) return true;
  if (saved === null) return true;
  return (
    input.mechanism !== saved.mechanism ||
    (input.tool ?? null) !== saved.tool ||
    (input.location ?? null) !== saved.location
  );
}
