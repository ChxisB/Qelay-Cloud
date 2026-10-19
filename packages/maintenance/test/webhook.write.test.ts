import { describe, expect, test } from 'bun:test';
import type { PostgresStore } from '@qelay-cloud/store-postgres';
import { noTelemetry } from '../src/telemetry';
import { writeOnce } from '../src/webhookWrite';

const storeOf = (writeDeliveries: () => Promise<unknown>) =>
  ({ webhooks: { writeDeliveries } }) as unknown as Pick<PostgresStore, 'webhooks'>;

describe('writeOnce', () => {
  test('reports the rows made and whether more wait, and gauges a gap', async () => {
    const gauges: Array<[string, number]> = [];
    const telemetry = {
      ...noTelemetry,
      gauge: (name: string, value: number) => void gauges.push([name, value]),
    };
    const store = storeOf(async () => ({
      active: true,
      events: 5,
      written: 4,
      more: true,
      gap: true,
    }));
    expect(await writeOnce(store, telemetry)).toEqual({ more: true, written: 4, failed: false });
    expect(gauges).toEqual([
      ['webhooks.written', 4],
      ['webhooks.writer_gaps', 1],
    ]);
  });

  test('a store error is reported, not thrown', async () => {
    const errors: string[] = [];
    const telemetry = { ...noTelemetry, error: (step: string) => void errors.push(step) };
    const store = storeOf(async () => {
      throw new Error('db down');
    });
    expect(await writeOnce(store, telemetry)).toEqual({ more: false, written: 0, failed: true });
    expect(errors).toEqual(['webhook-writer']);
  });
});
