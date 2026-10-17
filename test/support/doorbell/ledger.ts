import type { SQL } from 'bun';

/**
 * What every worker saw and did, in wall-clock order. The invariant check compares it with the
 * database. Check names match the task 02 model harness (`test/model/invariants.ts`), which checks
 * the same invariants against a model under virtual time; here the store is `PostgresStore` and the
 * bells go through a broker emulator in real time.
 */
export class Ledger {
  readonly claims: Array<{ jobId: string; owner: string; token: string; at: number }> = [];
  readonly runs: Array<{ jobId: string; owner: string; start: number; end: number }> = [];
  readonly settles: Array<{
    jobId: string;
    owner: string;
    token: string;
    applied: boolean;
    /** When the settle call began, not when it returned: the lease check happens inside the call. */
    startedAt: number;
  }> = [];

  claimed(jobId: string, owner: string, token: string): void {
    this.claims.push({ jobId, owner, token, at: Date.now() });
  }

  ran(jobId: string, owner: string, start: number): void {
    this.runs.push({ jobId, owner, start, end: Date.now() });
  }

  settled(
    jobId: string,
    owner: string,
    token: string,
    applied: boolean,
    startedAt: number = Date.now()
  ): void {
    this.settles.push({ jobId, owner, token, applied, startedAt });
  }
}

export interface Expectations {
  /** Attempts each job must show at the end (I4). Default 0: no job failed or crashed. */
  readonly attempts?: (jobId: string) => number;
}

interface JobRow {
  id: string;
  state: string;
  attempts: number;
  max_attempts: number;
  lease_token: string | null;
  has_dlq_entry: boolean;
}

/**
 * Every job ran to completion exactly once, under the lease of its last claim, with its attempts
 * counted and no DLQ entry. Returns the violations, so a test can assert `[]` and print all of them
 * at once.
 */
export async function checkInvariants(
  sql: SQL,
  namespace: string,
  ledger: Ledger,
  ids: readonly string[],
  expectations: Expectations = {}
): Promise<string[]> {
  const violations: string[] = [];
  const violate = (check: string, detail: string) => violations.push(`${check}: ${detail}`);
  const list = sql.array([...ids], 'TEXT');
  const rows = new Map(
    (
      await sql<JobRow[]>`
        SELECT id, state, attempts, max_attempts, lease_token,
               dlq_entry IS NOT NULL AS has_dlq_entry
        FROM qcloud_jobs WHERE namespace = ${namespace} AND id = ANY(${list})`
    ).map((row) => [row.id, row])
  );
  const pulled = new Map(
    (
      await sql<Array<{ job_id: string; count: number }>>`
        SELECT job_id, count(*)::int AS count FROM qcloud_events
        WHERE namespace = ${namespace} AND event_type = 'pulled' AND job_id = ANY(${list})
        GROUP BY job_id`
    ).map((row) => [row.job_id, row.count])
  );
  for (const id of ids) {
    const row = rows.get(id);
    if (!row) {
      violate('I1.noLoss', `${id} is gone`);
      continue;
    }
    if (row.state !== 'completed') {
      violate('I3.nothingStuck', `${id} is ${row.state}, not completed, at the deadline`);
    }
    const runs = ledger.runs.filter((run) => run.jobId === id).sort((a, b) => a.start - b.start);
    for (let index = 1; index < runs.length; index++) {
      if (runs[index]!.start < runs[index - 1]!.end) {
        violate(
          'I2.singleLiveLease',
          `${id} ran on ${runs[index - 1]!.owner} and ${runs[index]!.owner} at once`
        );
      }
    }
    const claims = ledger.claims.filter((claim) => claim.jobId === id);
    const applied = ledger.settles.filter((settle) => settle.jobId === id && settle.applied);
    if (row.state === 'completed' && applied.length === 0) {
      violate('I1.noLoss', `${id} completed but no worker's completion was applied`);
    }
    // A claim settles at most once. A failed job that retries settles once per claim, in order:
    // each settle must have begun before the next claim, or a stale holder was let through.
    const settledTokens = new Set<string>();
    for (const settle of applied) {
      const index = claims.findIndex((claim) => claim.token === settle.token);
      if (index < 0 || settledTokens.has(settle.token)) {
        violate(
          'I2.staleTokenRejected',
          `${id} settled ${index < 0 ? 'with an unknown token' : 'twice with one token'}`
        );
      } else if (index < claims.length - 1 && settle.startedAt > claims[index + 1]!.at) {
        violate('I2.staleTokenRejected', `${id} settled by ${settle.owner} with a stale token`);
      }
      settledTokens.add(settle.token);
    }
    if (row.state === 'completed' && applied.at(-1)?.token !== claims.at(-1)?.token) {
      violate(
        'I2.staleTokenRejected',
        `${id} completed under a token that is not its last claim's`
      );
    }
    if ((pulled.get(id) ?? 0) !== claims.length) {
      violate(
        'CLAIM.ledger',
        `${id} has ${pulled.get(id) ?? 0} pulled events, workers saw ${claims.length} claims`
      );
    }
    const expectedAttempts = expectations.attempts?.(id) ?? 0;
    if (row.attempts !== expectedAttempts) {
      violate('I4.attemptsCounted', `${id} has ${row.attempts} attempts, ${expectedAttempts} due`);
    }
    if (row.attempts > row.max_attempts) {
      violate('I4.attemptsBounded', `${id} has ${row.attempts} of ${row.max_attempts} attempts`);
    }
    if (row.has_dlq_entry) violate('I5.dlqExactlyOnce', `${id} is ${row.state} with a DLQ entry`);
    if (row.lease_token !== null && row.state !== 'active') {
      violate('I2.singleLiveLease', `${id} is ${row.state} but still holds a lease token`);
    }
  }
  return violations;
}
