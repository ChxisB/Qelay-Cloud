import { expect, test } from 'bun:test';
import { createTestSchema, describeDb, testDatabaseUrl } from '../../test/support/db';
import { runDemo } from './src/demo';

describeDb('examples/orders', () => {
  test('the example does what its README says, on the local transport', async () => {
    const schema = await createTestSchema();
    try {
      const report = await runDemo({
        databaseUrl: testDatabaseUrl(),
        schema: schema.name,
        namespace: 'orders',
        transport: 'local',
      });
      expect(report.deadLettered).toEqual([{ reason: 'max_attempts_exceeded', attempts: 3 }]);
      // Never early; late by the poll and the tick, not by seconds.
      expect(report.reminderLateByMs).toBeGreaterThanOrEqual(0);
      expect(report.reminderLateByMs).toBeLessThan(2_000);
    } finally {
      await schema.drop();
    }
  }, 60_000);
});
