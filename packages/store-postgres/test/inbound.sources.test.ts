import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { MAX_SOURCES, UnsupportedOptionError, WEBHOOK_SECRET_GRACE_MS } from '@qelay-cloud/core';
import { describeDb } from '../../../test/support/db';
import { SourceInUseError, SourceLimitError, SourceNameTakenError, WebhookKeyError } from '../src';
import { resetTables } from './finishHelpers';
import { addRoute, addSource } from './inboundHelpers';
import type { TestStore } from './storeHelpers';
import { openTestStore } from './storeHelpers';
import { KEY } from './webhookHelpers';

const HMAC = { kind: 'hmac', header: 'x-signature' } as const;

describeDb('inbound sources: the operator side', () => {
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

  test('a source shows its token once; only the hash is kept, and a listing never holds a token or a secret', async () => {
    const made = await addSource(t, { verification: HMAC });
    expect(made.token).toMatch(/^qin_[A-Za-z0-9_-]{43}$/);
    expect(made.secret).toMatch(/^qsec_[0-9a-f]{64}$/);
    expect(made).toMatchObject({
      name: 'Billing',
      enabled: true,
      signed: true,
      verification: { kind: 'hmac', header: 'x-signature', username: null },
    });
    const shown = JSON.stringify([
      await t.store.sources.list(),
      await t.store.sources.get(made.id),
    ]);
    expect(shown).not.toContain(made.token!);
    expect(shown).not.toContain(made.secret!);
    const [row] = await t.fresh.sql<Array<{ token_hash: string; secret_sealed: string }>>`
      SELECT token_hash, secret_sealed FROM qcloud_sources`;
    expect(row!.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row!.secret_sealed).not.toContain(made.secret!);
  });

  test('the token finds the source with its secret opened; a made-up, malformed or rotated token finds nothing', async () => {
    const made = await addSource(t, { verification: HMAC });
    expect(await t.store.sources.findByToken(made.token!)).toEqual({
      id: made.id,
      enabled: true,
      verification: { kind: 'hmac', header: 'x-signature', username: null },
      secret: made.secret!,
      previousSecret: null,
      secretUnreadable: false,
    });
    expect(await t.store.sources.findByToken(`qin_${'a'.repeat(43)}`)).toBeNull();
    expect(await t.store.sources.findByToken('nope')).toBeNull();
    expect(await t.store.sources.findByToken(`${made.token!}x`)).toBeNull();

    const rotated = await t.store.sources.rotateToken(made.id);
    expect(rotated!.token).not.toBe(made.token);
    expect(await t.store.sources.findByToken(made.token!)).toBeNull();
    expect((await t.store.sources.findByToken(rotated!.token!))!.id).toBe(made.id);
  });

  test('a source with no verification has no secret, and a given secret is kept as given', async () => {
    const open = await addSource(t, { name: 'Open' });
    expect(open).toMatchObject({ signed: false, secret: null });
    expect((await t.store.sources.findByToken(open.token!))!.secret).toBeNull();
    await expect(addSource(t, { name: 'X', secret: 'a'.repeat(20) })).rejects.toBeInstanceOf(
      UnsupportedOptionError
    );
    const given = 'my-own-shared-secret-1234';
    const basic = await addSource(t, {
      name: 'Basic',
      verification: { kind: 'basic', username: 'svc' },
      secret: given,
    });
    expect(basic.secret).toBeNull();
    expect((await t.store.sources.findByToken(basic.token!))!.secret).toBe(given);
  });

  test('verification is checked: an unknown kind, a missing header and a colon in a user name are refused', async () => {
    for (const verification of [
      { kind: 'oauth' },
      { kind: 'hmac' },
      { kind: 'api_key', header: 'bad header' },
      { kind: 'basic', username: 'a:b' },
    ]) {
      await expect(addSource(t, { verification: verification as never })).rejects.toBeInstanceOf(
        UnsupportedOptionError
      );
    }
    expect(await t.store.sources.list()).toEqual([]);
  });

  test('names are unique per namespace, required, and the cap holds', async () => {
    await addSource(t);
    await expect(addSource(t)).rejects.toBeInstanceOf(SourceNameTakenError);
    await expect(addSource(t, { name: '  ' })).rejects.toBeInstanceOf(UnsupportedOptionError);
    const other = await addSource(t, { name: 'Other' });
    await expect(t.store.sources.update(other.id, { name: 'Billing' })).rejects.toBeInstanceOf(
      SourceNameTakenError
    );
    expect(await t.store.sources.update(other.id, { name: 'Other' })).toMatchObject({
      name: 'Other',
    });

    await t.fresh.sql`
      INSERT INTO qcloud_sources (namespace, id, name, token_hash, created_by, created_at, updated_at)
      SELECT 'test', 'bulk' || n, 'bulk' || n, 'h' || n, 'me', 1, 1 FROM generate_series(1, ${MAX_SOURCES - 2}) n`;
    await expect(addSource(t, { name: 'One too many' })).rejects.toBeInstanceOf(SourceLimitError);
  });

  test('update renames or switches it off; nothing to change, a bad value and a missing source are told apart', async () => {
    const made = await addSource(t);
    expect(await t.store.sources.update(made.id, { enabled: false })).toMatchObject({
      enabled: false,
      name: 'Billing',
    });
    expect((await t.store.sources.findByToken(made.token!))!.enabled).toBe(false);
    await expect(t.store.sources.update(made.id, {})).rejects.toBeInstanceOf(
      UnsupportedOptionError
    );
    await expect(
      t.store.sources.update(made.id, { enabled: 'yes' as never })
    ).rejects.toBeInstanceOf(UnsupportedOptionError);
    expect(await t.store.sources.update('missing', { enabled: true })).toBeNull();
  });

  test('rotating the secret keeps the old one for the grace; a source that does not verify has none to rotate', async () => {
    const made = await addSource(t, { verification: HMAC });
    const rotated = await t.store.sources.rotateSecret(made.id);
    expect(rotated!.secret).toMatch(/^qsec_/);
    expect(rotated).toMatchObject({
      token: null,
      previousSecretUntil: t.clock.now() + WEBHOOK_SECRET_GRACE_MS,
    });
    expect(await t.store.sources.findByToken(made.token!)).toMatchObject({
      secret: rotated!.secret,
      previousSecret: made.secret,
    });
    t.clock.advance(WEBHOOK_SECRET_GRACE_MS + 1);
    expect(await t.store.sources.findByToken(made.token!)).toMatchObject({
      secret: rotated!.secret,
      previousSecret: null,
    });
    const open = await addSource(t, { name: 'Open' });
    await expect(t.store.sources.rotateSecret(open.id)).rejects.toBeInstanceOf(
      UnsupportedOptionError
    );
    expect(await t.store.sources.rotateSecret('missing')).toBeNull();
  });

  test('a source cannot be deleted while a route listens to it; once the route goes it can', async () => {
    const made = await addSource(t);
    const route = await addRoute(t, made.id);
    await expect(t.store.sources.delete(made.id)).rejects.toBeInstanceOf(SourceInUseError);
    expect(await t.store.sources.get(made.id)).not.toBeNull();
    expect(await t.store.webhooks.delete(route.id)).toBe(true);
    expect(await t.store.sources.delete(made.id)).toBe(true);
    expect(await t.store.sources.delete(made.id)).toBe(false);
  });

  test('a route needs a source that exists, and can be turned off and on', async () => {
    const made = await addSource(t);
    const route = await addRoute(t, made.id);
    expect(route).toMatchObject({ source: made.id });
    await expect(addRoute(t, 'missing')).rejects.toBeInstanceOf(UnsupportedOptionError);
    await expect(
      t.store.webhooks.create({ url: 'https://hooks.example.com/in' }, 'tester')
    ).rejects.toBeInstanceOf(UnsupportedOptionError);
    const a = await addRoute(t, made.id, { destination: 'queue', target: 'a', url: undefined });
    expect(a).toMatchObject({ destination: 'queue', target: 'a', source: made.id });
    expect((await t.store.webhooks.setEnabled(a.id, false))!.enabled).toBe(false);
    expect((await t.store.webhooks.setEnabled(a.id, true))!.enabled).toBe(true);
  });

  test('a route can move to another source, but not to one that is missing', async () => {
    const one = await addSource(t);
    const two = await addSource(t, { name: 'Two' });
    const route = await addRoute(t, one.id);
    expect(route.source).toBe(one.id);
    expect(await t.store.webhooks.update(route.id, { source: two.id })).toMatchObject({
      source: two.id,
    });
    await expect(t.store.webhooks.update(route.id, { source: 'missing' })).rejects.toBeInstanceOf(
      UnsupportedOptionError
    );
    expect((await t.store.webhooks.get(route.id))!.source).toBe(two.id);
  });

  test('a store without a webhook key cannot make a source that verifies', async () => {
    const keyless = t.another({ webhookKey: undefined as never });
    await expect(
      keyless.sources.create({ name: 'Signed', verification: HMAC }, 'tester')
    ).rejects.toBeInstanceOf(WebhookKeyError);
    const open = await keyless.sources.create({ name: 'Open' }, 'tester');
    expect(open.signed).toBe(false);
    const signed = await addSource(t, { name: 'Signed', verification: HMAC });
    expect(await keyless.sources.findByToken(signed.token!)).toMatchObject({
      secret: null,
      secretUnreadable: true,
    });
  });
});
