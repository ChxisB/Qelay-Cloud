import { describe, expect, test } from 'bun:test';
import { LATEST_VERSION, MIGRATIONS, WORKFLOWS_SINCE_VERSION } from '../src/schema/migrations';

describe('the schema versions a capability is read from', () => {
  test('the workflow pages need the migration that adds the definitions registry, and every later one', () => {
    // The Control API turns `features.workflows` on from this number, so it must name the migration
    // after the executions table: a page that reads `qcloud_workflow_definitions` needs both.
    const named = MIGRATIONS.find((migration) => migration.version === WORKFLOWS_SINCE_VERSION);
    expect(named?.name).toBe('workflow definitions');
    const executions = MIGRATIONS.find((migration) => migration.name === 'workflow executions');
    expect(executions!.version).toBeLessThan(WORKFLOWS_SINCE_VERSION);
    expect(WORKFLOWS_SINCE_VERSION).toBeLessThanOrEqual(LATEST_VERSION);
  });

  test('migration versions are consecutive from 1, so a version number means what it says', () => {
    expect(MIGRATIONS.map((migration) => migration.version)).toEqual(
      MIGRATIONS.map((_, index) => index + 1)
    );
  });
});
