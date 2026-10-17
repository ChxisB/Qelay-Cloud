import { describe, expect, test } from 'bun:test';
import type { SQL, TransactionSQL } from 'bun';
import { isRetryableTransactionError, runTransaction } from '../src/store/retry';

/** A stand-in for `sql` whose `begin` runs the work and fails as scripted first. */
function scripted(failures: unknown[]) {
  let begins = 0;
  const sql = {
    begin: async (work: (tx: TransactionSQL) => Promise<unknown>) => {
      begins++;
      const failure = failures.shift();
      if (failure !== undefined) throw failure;
      return work({} as TransactionSQL);
    },
  } as unknown as SQL;
  return { sql, begins: () => begins };
}

const fail = (code: string) => Object.assign(new Error(`postgres ${code}`), { errno: code });

describe('claim: transaction retry', () => {
  test.each(['40001', '40P01', '55P03'])(
    '%s is retryable: the transaction was rolled back',
    (code) => {
      expect(isRetryableTransactionError(fail(code))).toBe(true);
    }
  );

  test.each([
    ['a unique violation', fail('23505')],
    ['a syntax error', fail('42601')],
    [
      'a dropped connection',
      Object.assign(new Error('closed'), { code: 'ERR_POSTGRES_CONNECTION_CLOSED' }),
    ],
    ['a plain error', new Error('boom')],
    ['a string', 'boom'],
    ['null', null],
  ])('%s is not retryable: it may have committed, or replaying cannot help', (_label, error) => {
    expect(isRetryableTransactionError(error)).toBe(false);
  });

  test('the state is read from errno, sqlState or code', () => {
    expect(isRetryableTransactionError({ sqlState: '40001' })).toBe(true);
    expect(isRetryableTransactionError({ code: '40P01' })).toBe(true);
  });

  test('a clean run is not repeated', async () => {
    const { sql, begins } = scripted([]);
    expect(await runTransaction(sql, async () => 'done')).toBe('done');
    expect(begins()).toBe(1);
  });

  test('a deadlock is replayed once, and the replay result is returned', async () => {
    const { sql, begins } = scripted([fail('40P01')]);
    const seen: (string | null)[] = [];
    expect(
      await runTransaction(
        sql,
        async () => 'done',
        (state) => seen.push(state)
      )
    ).toBe('done');
    expect(begins()).toBe(2);
    expect(seen).toEqual(['40P01']);
  });

  test('a second conflict is surfaced: two attempts and no more', async () => {
    const { sql, begins } = scripted([fail('40001'), fail('40001'), fail('40001')]);
    await expect(runTransaction(sql, async () => 'done')).rejects.toMatchObject({ errno: '40001' });
    expect(begins()).toBe(2);
  });

  test('an error that is not retryable is surfaced at once', async () => {
    const { sql, begins } = scripted([fail('23505')]);
    await expect(runTransaction(sql, async () => 'done')).rejects.toMatchObject({ errno: '23505' });
    expect(begins()).toBe(1);
  });

  test('an error thrown by the work itself is judged the same way', async () => {
    const { sql, begins } = scripted([]);
    await expect(
      runTransaction(sql, async () => {
        throw new Error('the work failed');
      })
    ).rejects.toThrow('the work failed');
    expect(begins()).toBe(1);
  });
});
