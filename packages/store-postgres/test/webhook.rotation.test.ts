import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { WEBHOOK_SECRET_GRACE_MS } from '@qelay-cloud/core';
import { describeDb } from '../../../test/support/db';
import { WebhookKeyError } from '../src/errors';
import { resetTables } from './finishHelpers';
import type { TestStore } from './storeHelpers';
import { openTestStore } from './storeHelpers';
import { addHook, CLAIM, event, journal, KEY, outcome, POLICY, SECRET } from './webhookHelpers';

describeDb('webhooks: rotating the secret', () => {
  let t: TestStore;
  beforeAll(async () => {
    t = await openTestStore({ webhookKey: KEY });
  });
  afterAll(async () => {
    await t.drop();
  });
  beforeEach(async () => {
    await resetTables(t);
  });

  /** The secrets a freshly journalled event's delivery is claimed with, then recorded as sent. */
  const claimedSecrets = async (jobId: string) => {
    await journal(t, [event('pushed', 'q', jobId)]);
    const [claimed] = await t.store.webhooks.claimDue(CLAIM);
    await t.store.webhooks.record([outcome(claimed!, { ok: true })], POLICY);
    return { secret: claimed!.secret, previousSecret: claimed!.previousSecret };
  };

  test('the old secret signs beside the new one for the grace, then no longer', async () => {
    const hook = await addHook(t, { secret: SECRET });
    expect(await claimedSecrets('a')).toEqual({ secret: SECRET, previousSecret: null });

    const rotated = await t.store.webhooks.rotateSecret(hook.id);
    expect(rotated!.secret).toMatch(/^whsec_[0-9a-f]{64}$/);
    expect(rotated).toMatchObject({
      signed: true,
      previousSecretUntil: t.clock.now() + WEBHOOK_SECRET_GRACE_MS,
    });
    expect(JSON.stringify(await t.store.webhooks.get(hook.id))).not.toContain(rotated!.secret!);
    expect(await claimedSecrets('b')).toEqual({ secret: rotated!.secret!, previousSecret: SECRET });

    t.clock.advance(WEBHOOK_SECRET_GRACE_MS + 1);
    expect(await claimedSecrets('c')).toEqual({ secret: rotated!.secret!, previousSecret: null });
    await t.store.webhooks.prune(100);
    const [row] = await t.fresh.sql<Array<{ p: string | null }>>`
      SELECT secret_previous_sealed AS p FROM qcloud_webhooks`;
    expect(row!.p).toBeNull();
  });

  test('a secret can be given, rotating twice keeps only the latest two, and an unsigned webhook has no old one', async () => {
    const hook = await addHook(t, { secret: SECRET });
    const second = 'whsec_second0123456789abcdef0123456789';
    const third = 'whsec_third00123456789abcdef0123456789';
    expect(await t.store.webhooks.rotateSecret(hook.id, second)).toMatchObject({ secret: null });
    await t.store.webhooks.rotateSecret(hook.id, third);
    expect(await claimedSecrets('a')).toEqual({ secret: third, previousSecret: second });

    const keyless = t.another({ webhookKey: undefined as never });
    const unsigned = await addHook({ store: keyless });
    await expect(keyless.webhooks.rotateSecret(unsigned.id)).rejects.toBeInstanceOf(
      WebhookKeyError
    );
    expect(await t.store.webhooks.rotateSecret('missing')).toBeNull();
    await t.store.webhooks.rotateSecret(unsigned.id, second);
    expect(await t.store.webhooks.get(unsigned.id)).toMatchObject({
      signed: true,
      previousSecretUntil: null,
    });
  });

  test('a secret that is too short is refused before anything changes', async () => {
    const hook = await addHook(t, { secret: SECRET });
    await expect(t.store.webhooks.rotateSecret(hook.id, 'short')).rejects.toThrow();
    expect(await claimedSecrets('a')).toEqual({ secret: SECRET, previousSecret: null });
  });
});
