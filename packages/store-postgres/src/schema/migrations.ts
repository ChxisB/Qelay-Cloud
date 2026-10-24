import { createHash } from 'node:crypto';
import { AUDIT_STATEMENTS } from './ddl/audit';
import { AUXILIARY_STATEMENTS } from './ddl/auxiliary';
import { DELIVERY_PARTITION_STATEMENTS } from './ddl/deliveryPartitions';
import { EVENT_STATEMENTS } from './ddl/events';
import { FLOW_ROOT_STATEMENTS, FLOW_STATEMENTS } from './ddl/flows';
import { INBOUND_SOURCE_STATEMENTS } from './ddl/inboundSources';
import { JOBS_STATEMENTS } from './ddl/jobs';
import { PROGRESS_STATEMENTS } from './ddl/progress';
import { QUEUE_POLICY_WINDOW_STATEMENTS } from './ddl/queuePolicyWindow';
import { TICK_STATEMENTS } from './ddl/tick';
import { TICK_STATE_STATEMENTS } from './ddl/tickState';
import { TUNING_STATEMENTS } from './ddl/tuning';
import { WEBHOOK_DESTINATION_STATEMENTS } from './ddl/webhookDestinations';
import { WEBHOOK_DESTINATION_TABLE_STATEMENTS } from './ddl/webhookDestinationTable';
import { WEBHOOK_ISSUE_STATEMENTS } from './ddl/webhookIssues';
import { REMOVE_JOB_EVENT_STATEMENTS } from './ddl/webhookJobEvents';
import { WEBHOOK_PAUSE_STATEMENTS } from './ddl/webhookPause';
import { WEBHOOK_RULE_STATEMENTS } from './ddl/webhookRules';
import { WEBHOOK_STATEMENTS } from './ddl/webhooks';
import { WEBHOOK_SCHEDULE_BATCH_STATEMENTS } from './ddl/webhookScheduleBatch';
import { WEBHOOK_WRITER_STATEMENTS } from './ddl/webhookWriter';
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
  { version: 12, name: 'hot table tuning', statements: TUNING_STATEMENTS },
  { version: 13, name: 'webhook delivery partitions', statements: DELIVERY_PARTITION_STATEMENTS },
  { version: 14, name: 'webhook delivery writer', statements: WEBHOOK_WRITER_STATEMENTS },
  { version: 15, name: 'webhook pause and rotation', statements: WEBHOOK_PAUSE_STATEMENTS },
  { version: 16, name: 'webhook destinations', statements: WEBHOOK_DESTINATION_STATEMENTS },
  { version: 17, name: 'webhook rules', statements: WEBHOOK_RULE_STATEMENTS },
  { version: 18, name: 'webhook issues', statements: WEBHOOK_ISSUE_STATEMENTS },
  { version: 19, name: 'saved destinations', statements: WEBHOOK_DESTINATION_TABLE_STATEMENTS },
  { version: 20, name: 'inbound sources', statements: INBOUND_SOURCE_STATEMENTS },
  { version: 21, name: 'remove job events', statements: REMOVE_JOB_EVENT_STATEMENTS },
  { version: 22, name: 'route schedule and batch', statements: WEBHOOK_SCHEDULE_BATCH_STATEMENTS },
  { version: 23, name: 'queue policy and run window', statements: QUEUE_POLICY_WINDOW_STATEMENTS },
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
