import { canPeekDeadLetters } from '@qelay-cloud/core';
import type { DeadLetterItem, DeadLettersResponse } from '../opsTypes';
import type { OpsContext } from './context';

/** Largest sample of one queue's dead-letter queue: a page for a person, not a way to read a backlog. */
export const MAX_DEAD_LETTER_SAMPLE = 50;

const none = (
  queue: string,
  reason: DeadLettersResponse['reason'],
  timestamp: number
): DeadLettersResponse => ({
  ok: true,
  queue,
  available: false,
  reason,
  items: [],
  timestamp,
});

/**
 * A sample of the poison bells the broker gave up on for one queue, each with the job it rang for
 * and whether that job still exists. Reading is a peek: nothing is acknowledged, deleted or
 * redriven (redrive is a runbook step), and the bells are given back to the broker at once.
 *
 * "Not available" is an answer with a reason, never an empty list: a transport with no dead-letter
 * queue says `not_supported`, and a broker that could not be read says `unreachable`.
 */
export async function readDeadLetters(
  ctx: OpsContext,
  queue: string,
  limit: number
): Promise<DeadLettersResponse> {
  const jobs = ctx.jobs!;
  const now = ctx.clock.now();
  if (ctx.deps.transport.doorbellDeadLetter === false || !canPeekDeadLetters(jobs.transport)) {
    return none(queue, 'not_supported', now);
  }
  let letters;
  try {
    letters = await jobs.transport.peekDeadLetters(queue, Math.min(limit, MAX_DEAD_LETTER_SAMPLE));
  } catch (error) {
    ctx.logger.warn('dead-letter peek failed', {
      queue,
      error: error instanceof Error ? error.name : 'unknown',
    });
    return none(queue, 'unreachable', now);
  }
  const idOf = (letter: (typeof letters)[number]): string | null => letter.bell?.jobId ?? null;
  const ids = [...new Set(letters.map(idOf).filter((id): id is string => id !== null))];
  const existing = await jobs.store.deployment.existing(ids);
  const items: DeadLetterItem[] = letters.map((letter) => {
    const jobId = idOf(letter);
    return {
      jobId,
      queue,
      deliveryCount: letter.deliveryCount,
      deadLetteredAt: letter.deadLetteredAt,
      ageMs: letter.deadLetteredAt === null ? null : Math.max(0, now - letter.deadLetteredAt),
      jobExists: jobId !== null && existing.has(jobId),
    };
  });
  return { ok: true, queue, available: true, reason: null, items, timestamp: now };
}
