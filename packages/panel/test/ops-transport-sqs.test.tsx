import { describe, expect, test } from 'bun:test';
import { installOpsHooks, queue, transport } from './ops.helpers';
import { rowFor, show } from './transportPage.helpers';

installOpsHooks();

const SQS = {
  name: 'aws-sqs',
  maxDeliverDelayMs: 900_000,
  ordering: 'best-effort',
  approximateCounts: true,
};
const SQS_FRESHNESS = {
  observedAt: 1,
  ageMs: 20_000,
  maxStalenessMs: 300_000,
  source: 'sqs-queue-attributes+cloudwatch',
};

describe('the Transport page on SQS', () => {
  test('shows visible, in flight, delayed and dead-letter, each marked approximate', async () => {
    const { page } = await show(
      transport(
        [
          queue('emails', {
            doorbellDepth: 14,
            inFlight: 3,
            delayed: 6,
            deadLetterDepth: 2,
            freshness: SQS_FRESHNESS,
          }),
        ],
        { transport: SQS }
      )
    );
    const headers = [...page.host.querySelectorAll('thead th')].map((th) => th.textContent);
    expect(headers).toContain('In flight');
    expect(headers).toContain('Delayed');
    const row = rowFor(page.host, 'emails');
    for (const figure of ['≈14', '≈3', '≈6', '≈2']) expect(row).toContain(figure);
    expect(row).toContain('20s ago, up to 5m behind');
    expect(row).toContain('sqs-queue-attributes+cloudwatch');
    // What the store knows is exact and is not marked.
    expect(rowFor(page.host, 'emails')).not.toContain('≈0');
    page.unmount();
  });

  test('says in words that this broker counts approximately, and what the delay limit means', async () => {
    const { page } = await show(
      transport([queue('a', { inFlight: 0, delayed: 0 })], { transport: SQS })
    );
    expect(page.text()).toContain('approximate');
    expect(page.text()).toContain('Up to 15m.');
    expect(page.text()).toContain('Best-effort ordering');
    page.unmount();
  });

  test('a count the broker did not give is "unknown", never 0, in the new columns too', async () => {
    const { page } = await show(
      transport(
        [
          queue('seen', { inFlight: 4, delayed: 1 }),
          queue('blind', {
            doorbellDepth: null,
            inFlight: null,
            delayed: null,
            deadLetterDepth: null,
          }),
        ],
        { transport: SQS }
      )
    );
    const blind = rowFor(page.host, 'blind');
    expect(blind.match(/unknown/g)!.length).toBeGreaterThanOrEqual(4);
    expect(blind).not.toContain('≈0');
    page.unmount();
  });

  test('a broker that counts exactly has no approximate marks, and no in-flight column when it gives none', async () => {
    const { page } = await show(transport([queue('a', { doorbellDepth: 14 })]));
    const headers = [...page.host.querySelectorAll('thead th')].map((th) => th.textContent);
    expect(headers).not.toContain('In flight');
    expect(headers).not.toContain('Delayed');
    expect(rowFor(page.host, 'a')).not.toContain('≈');
    expect(page.text()).not.toContain('approximate');
    page.unmount();
  });
});
