import { describe, expect, test } from 'bun:test';
import { MemoryTransport } from '../../../packages/transport-local/src';
import { FaultyDoorbells } from '../../model/transport';
import { FaultyTransport } from './faultyTransport';
import { RING_FAULTS } from './vocabulary';

const LATE_MS = 120;

/**
 * The model harness (virtual time) and `FaultyTransport` (real time) both apply a `RingFault`. This
 * ties them: for each word of the vocabulary, a bell rung with it is seen the same number of times
 * before and after its lag in both, so a scenario's fault and a model command's mean one thing.
 */
describe('the ring fault vocabulary', () => {
  for (const fault of RING_FAULTS) {
    test(`'${fault}' delivers the same bells in the model and through FaultyTransport`, async () => {
      const model = new FaultyDoorbells();
      model.ring([{ namespace: 'ns', queue: 'q', jobId: 'job' }], fault);
      const modelBefore = model.deliverable('q');
      model.flushLate();
      const modelAfter = model.deliverable('q');

      const memory = new MemoryTransport();
      const faulty = new FaultyTransport(memory, { lateMs: LATE_MS });
      let seen = 0;
      const subscription = faulty.subscribe(
        'q',
        async (delivery) => {
          seen += 1;
          await delivery.ack();
        },
        { capacity: () => 10 }
      );
      faulty.inject(fault, LATE_MS);
      await faulty.ring([{ bell: { namespace: 'ns', queue: 'q', jobId: 'job' } }]);
      memory.tick();
      await Bun.sleep(30);
      const before = seen;
      await Bun.sleep(LATE_MS + 100);
      memory.tick();
      await Bun.sleep(30);
      const after = seen;
      await subscription.close();
      faulty.release();
      await memory.close();

      expect([before, after]).toEqual([modelBefore, modelAfter]);
    });
  }
});
