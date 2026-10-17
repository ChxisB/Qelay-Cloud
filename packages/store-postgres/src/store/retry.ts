import type { SQL, TransactionSQL } from 'bun';

const MAX_ATTEMPTS = 2;
// serialization_failure, deadlock_detected, lock_not_available: each guarantees the transaction was rolled back.
const RETRYABLE_SQL_STATES: ReadonlySet<string> = new Set(['40001', '40P01', '55P03']);

function sqlState(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const record = error as Record<string, unknown>;
  for (const field of ['errno', 'sqlState', 'code']) {
    const value = record[field];
    if (typeof value === 'string' && /^[0-9A-Z]{5}$/.test(value)) return value;
  }
  return null;
}

/** True only for failures that guarantee the transaction was rolled back, so replaying it cannot double an effect. */
export function isRetryableTransactionError(error: unknown): boolean {
  const state = sqlState(error);
  return state !== null && RETRYABLE_SQL_STATES.has(state);
}

function retryDelayMs(failedAttempt: number): number {
  const base = 10 * 2 ** (failedAttempt - 1);
  return base + Math.floor(Math.random() * base);
}

/**
 * Runs `work` in a transaction and, after a rollback-certain conflict, once more. Ambiguous
 * failures (a dropped connection, a deadline) are never replayed here: the caller decides.
 * Adapted from Qelay's `transactionRetry.ts`. `onRetry` lets a test count replays.
 */
export async function runTransaction<T>(
  sql: SQL,
  work: (tx: TransactionSQL) => Promise<T>,
  onRetry?: (sqlState: string | null) => void
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await sql.begin(work);
    } catch (error) {
      if (attempt >= MAX_ATTEMPTS || !isRetryableTransactionError(error)) throw error;
      onRetry?.(sqlState(error));
      await Bun.sleep(retryDelayMs(attempt));
    }
  }
}
