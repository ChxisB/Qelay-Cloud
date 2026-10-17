import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { TestStore } from '../../../packages/store-postgres/test/storeHelpers';
import { openTestStore } from '../../../packages/store-postgres/test/storeHelpers';
import { describeDb } from '../db';
import { checkInvariants, Ledger } from './ledger';
import { uniqueNamespace } from './util';

const NAMESPACE = uniqueNamespace();

/**
 * The checker itself, on hand-built ledgers over one real completed job. Only the settle rules
 * are under test, so the other checks' violations (pull count, attempts) are filtered out. A
 * checker that cannot fail would make every scenario that uses it meaningless.
 */
describeDb('doorbell ledger: settles', () => {
  let t: TestStore;
  let id: string;

  beforeAll(async () => {
    t = await openTestStore({ clock: null, namespace: NAMESPACE });
    const [job] = await t.store.enqueue([{ queue: 'q-checker', data: {} }]);
    id = job!.id;
    const [claim] = await t.store.claim('q-checker', 'checker', 1, { leaseMs: 30_000 });
    await t.store.complete(claim!.lease, null);
  });

  afterAll(async () => {
    await t?.drop();
  });

  const settleViolations = async (build: (ledger: Ledger) => void) => {
    const ledger = new Ledger();
    build(ledger);
    const violations = await checkInvariants(t.fresh.sql, NAMESPACE, ledger, [id]);
    return violations.filter((line) => /^I[12]\./.test(line));
  };

  const claims = (ledger: Ledger, ...at: number[]) => {
    at.forEach((time, index) =>
      ledger.claims.push({ jobId: id, owner: 'w', token: `t${index + 1}`, at: time })
    );
  };

  test('a job that failed and retried settles once per claim, in order', async () => {
    expect(
      await settleViolations((ledger) => {
        claims(ledger, 100, 200);
        ledger.settled(id, 'w', 't1', true, 150);
        ledger.settled(id, 'w', 't2', true, 250);
      })
    ).toEqual([]);
  });

  test('a stale holder settling after the next claim, and being applied, is a violation', async () => {
    expect(
      await settleViolations((ledger) => {
        claims(ledger, 100, 200);
        ledger.settled(id, 'w', 't1', true, 300);
        ledger.settled(id, 'w', 't2', true, 350);
      })
    ).toEqual([`I2.staleTokenRejected: ${id} settled by w with a stale token`]);
  });

  test('a stale settle that was rejected is not a violation', async () => {
    expect(
      await settleViolations((ledger) => {
        claims(ledger, 100, 200);
        ledger.settled(id, 'w', 't1', false, 300);
        ledger.settled(id, 'w', 't2', true, 350);
      })
    ).toEqual([]);
  });

  test('one claim applied twice, an unknown token and a completion by an old claim are violations', async () => {
    expect(
      await settleViolations((ledger) => {
        claims(ledger, 100);
        ledger.settled(id, 'w', 't1', true, 150);
        ledger.settled(id, 'w', 't1', true, 160);
      })
    ).toEqual([`I2.staleTokenRejected: ${id} settled twice with one token`]);
    expect(
      await settleViolations((ledger) => {
        claims(ledger, 100);
        ledger.settled(id, 'w', 'other', true, 150);
      })
    ).toContain(`I2.staleTokenRejected: ${id} settled with an unknown token`);
    expect(
      await settleViolations((ledger) => {
        claims(ledger, 100, 200);
        ledger.settled(id, 'w', 't1', true, 150);
      })
    ).toEqual([
      `I2.staleTokenRejected: ${id} completed under a token that is not its last claim's`,
    ]);
  });

  test('other broken rules are named: a lost job, overlapping runs, claim count, attempts', async () => {
    const ledger = new Ledger();
    claims(ledger, 100, 200);
    ledger.runs.push(
      { jobId: id, owner: 'a', start: 100, end: 200 },
      { jobId: id, owner: 'b', start: 150, end: 250 }
    );
    ledger.settled(id, 'w', 't1', true, 150);
    const violations = await checkInvariants(t.fresh.sql, NAMESPACE, ledger, [id, 'missing'], {
      attempts: () => 2,
    });
    expect(violations).toEqual(
      expect.arrayContaining([
        'I1.noLoss: missing is gone',
        `I2.singleLiveLease: ${id} ran on a and b at once`,
        `CLAIM.ledger: ${id} has 1 pulled events, workers saw 2 claims`,
        `I4.attemptsCounted: ${id} has 0 attempts, 2 due`,
      ])
    );
  });
});
