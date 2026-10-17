import { UnsupportedOptionError } from '@qelay-cloud/core';
import {
  databaseOptionsFromEnv,
  MigrationError,
  migrate,
  openDatabase,
  SchemaDriftError,
  SchemaVersionError,
} from '@qelay-cloud/store-postgres';
import type { CliIo } from './io';
import { redactor } from './redact';

/** What a failed run is called in the log, so an operator can tell a refused schema from an outage. */
function kind(error: unknown): string {
  if (error instanceof SchemaVersionError) return 'schema_ahead';
  if (error instanceof SchemaDriftError) return 'schema_drift';
  if (error instanceof MigrationError) return 'migration_failed';
  return 'failed';
}

/**
 * `qcloud-api migrate`: brings the database to this build's schema and exits. It is the release
 * step (a Cloud Run Job), run once before the new revision takes traffic, so the services never
 * migrate on start. It needs only the database settings, and the URL may name a role that can run
 * DDL where the services' own role cannot.
 *
 * Exit 0 when the database is current (nothing applied is still 0), 1 when it could not be brought
 * there (the failed migration rolled back whole, so a second run starts from the same place), 2 for
 * a configuration error.
 */
export async function migrateCommand(
  env: Readonly<Record<string, string | undefined>>,
  io: CliIo
): Promise<number> {
  const redact = redactor(env);
  try {
    const options = databaseOptionsFromEnv(env, {
      applicationName: 'qcloud-migrate',
      purpose: 'the database to migrate',
    });
    const db = openDatabase(options);
    try {
      const result = await migrate(db);
      io.out(JSON.stringify({ level: 'info', msg: 'migrated', ...result }));
      return 0;
    } finally {
      await db.close({ timeout: 5_000 }).catch(() => {});
    }
  } catch (error) {
    if (error instanceof UnsupportedOptionError) {
      io.err(redact(`${error.name}: ${error.message}`));
      return 2;
    }
    io.err(
      JSON.stringify({
        level: 'error',
        msg: kind(error),
        error: redact(error instanceof Error ? `${error.name}: ${error.message}` : String(error)),
      })
    );
    return 1;
  }
}
