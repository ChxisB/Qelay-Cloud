import { createHash } from 'node:crypto';
import { AUDIT_STATEMENTS } from './ddl/audit';
import { AUXILIARY_STATEMENTS } from './ddl/auxiliary';
import { EVENT_STATEMENTS } from './ddl/events';
import { FLOW_ROOT_STATEMENTS, FLOW_STATEMENTS } from './ddl/flows';
import { JOBS_STATEMENTS } from './ddl/jobs';
import { PROGRESS_STATEMENTS } from './ddl/progress';
import { TICK_STATEMENTS } from './ddl/tick';
import { TICK_STATE_STATEMENTS } from './ddl/tickState';
import { WEBHOOK_STATEMENTS } from './ddl/webhooks';
import { WORKFLOW_DEFINITION_STATEMENTS } from './ddl/workflowDefinitions';
import { WORKFLOW_LIVE_STATEMENTS } from './ddl/workflowLive';
import { WORKFLOW_STATEMENTS } from './ddl/workflows';

export interface Migration {
  /** Contiguous from 1. Never renumbered, never edited once released. */
  readonly version: number;
  readonly name: string;
  /** One statement per entry, run in order inside the migration's transaction. */
  readonly statements: readonly string[];
}

/**
 * Forward-only. To change the schema, append a migration; never edit one that has shipped (the
 * runner stores a checksum of each and refuses a database whose recorded checksum differs).
 * A migration must be safe while workers on the previous version are still connected: add
 * nullable or defaulted columns, add indexes, and leave removal to a later migration once no
 * running version reads the column.
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'initial schema',
    statements: [...JOBS_STATEMENTS, ...AUXILIARY_STATEMENTS, ...EVENT_STATEMENTS],
  },
  { version: 2, name: 'unrung job index', statements: TICK_STATEMENTS },
  { version: 3, name: 'job progress', statements: PROGRESS_STATEMENTS },
  { version: 4, name: 'tick state', statements: TICK_STATE_STATEMENTS },
  { version: 5, name: 'operator audit', statements: AUDIT_STATEMENTS },
  { version: 6, name: 'flow failure policy', statements: FLOW_STATEMENTS },
  { version: 7, name: 'flow membership', statements: FLOW_ROOT_STATEMENTS },
  { version: 8, name: 'webhooks', statements: WEBHOOK_STATEMENTS },
  { version: 9, name: 'workflow executions', statements: WORKFLOW_STATEMENTS },
  {
    version: 10,
    name: 'workflow definitions',
    statements: WORKFLOW_DEFINITION_STATEMENTS,
  },
  { version: 11, name: 'workflow live index', statements: WORKFLOW_LIVE_STATEMENTS },
];

export const LATEST_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;

/**
 * The first migration a workflow store needs (the definitions registry the Control API reads). A
 * database below it cannot serve the workflow routes, so the panel is told to hide the page.
 */
export const WORKFLOWS_SINCE_VERSION = 10;

export function migrationChecksum(migration: Migration): string {
  const hash = createHash('sha256');
  for (const statement of migration.statements) hash.update(statement).update('\n;\n');
  return hash.digest('hex');
}

export interface ExpectedObjects {
  /** Tables, indexes and sequences: `pg_class` names. */
  readonly relations: ReadonlySet<string>;
  readonly functions: ReadonlySet<string>;
  readonly triggers: ReadonlySet<string>;
}

type ObjectKind = keyof ExpectedObjects;

const CREATES: ReadonlyArray<readonly [ObjectKind, RegExp]> = [
  ['relations', /^CREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX|SEQUENCE)\s+(\w+)/i],
  ['functions', /^CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(\w+)/i],
  ['triggers', /^CREATE\s+(?:CONSTRAINT\s+)?TRIGGER\s+(\w+)/i],
];

const DROPS: ReadonlyArray<readonly [ObjectKind, RegExp]> = [
  ['relations', /^DROP\s+(?:TABLE|INDEX|SEQUENCE)\s+(?:IF\s+EXISTS\s+)?(\w+)/i],
  ['functions', /^DROP\s+FUNCTION\s+(?:IF\s+EXISTS\s+)?(\w+)/i],
  ['triggers', /^DROP\s+TRIGGER\s+(?:IF\s+EXISTS\s+)?(\w+)/i],
];

/**
 * The objects the migrations up to `upTo` leave behind, read from their `CREATE` and `DROP`
 * statements. It is the drift check's manifest: nothing is listed twice, so it cannot disagree with
 * the DDL.
 */
export function expectedObjects(
  migrations: readonly Migration[],
  upTo = Number.POSITIVE_INFINITY
): ExpectedObjects {
  const found: Record<ObjectKind, Set<string>> = {
    relations: new Set(),
    functions: new Set(),
    triggers: new Set(),
  };
  for (const migration of migrations) {
    if (migration.version > upTo) continue;
    for (const raw of migration.statements) {
      const statement = raw.trimStart();
      for (const [kind, pattern] of CREATES) {
        const name = pattern.exec(statement)?.[1];
        if (name) found[kind].add(name.toLowerCase());
      }
      for (const [kind, pattern] of DROPS) {
        const name = pattern.exec(statement)?.[1];
        if (name) found[kind].delete(name.toLowerCase());
      }
    }
  }
  return found;
}
