import { describe, expect, test } from 'bun:test';
import type { DestinationFull } from '../src/lib/bq';
import { NAME_MAX } from '../src/pages/control/gateway/connectionPatch';
import {
  addBodyOf,
  addressOf,
  fieldsOfDestination,
  patchBodyOf,
} from '../src/pages/control/gateway/destinationFields';
import { destination } from './gateway.helpers';

const http = destination() as unknown as DestinationFull;
const queue = destination({
  id: 'dest-2',
  name: 'Refunds',
  kind: 'queue',
  url: '',
  target: 'refunds',
}) as unknown as DestinationFull;

describe('the body a new destination sends', () => {
  test('a webhook address sends the name, the kind and the url, trimmed', () => {
    expect(
      addBodyOf({ name: '  Billing  ', kind: 'http', address: ' https://billing.test/hook ' })
    ).toEqual({
      ok: true,
      body: { name: 'Billing', kind: 'http', url: 'https://billing.test/hook' },
    });
  });

  test('a queue sends the target and no url', () => {
    expect(addBodyOf({ name: 'Refunds', kind: 'queue', address: 'refunds' })).toEqual({
      ok: true,
      body: { name: 'Refunds', kind: 'queue', target: 'refunds' },
    });
  });

  test('a message names the field it is about, name first', () => {
    const blank = addBodyOf({ name: ' ', kind: 'http', address: 'not a url' });
    expect(blank).toMatchObject({ ok: false, field: 'name', msg: 'A destination needs a name.' });
    const long = addBodyOf({ name: 'x'.repeat(NAME_MAX + 1), kind: 'http', address: '' });
    expect(long).toMatchObject({ ok: false, field: 'name' });
    const badUrl = addBodyOf({ name: 'A', kind: 'http', address: 'ftp://billing.test' });
    expect(badUrl).toMatchObject({ ok: false, field: 'address' });
    const secretUrl = addBodyOf({
      name: 'A',
      kind: 'http',
      address: 'https://user:pw@billing.test',
    });
    expect(secretUrl).toMatchObject({ ok: false, field: 'address' });
    const badQueue = addBodyOf({ name: 'A', kind: 'queue', address: 'has space' });
    expect(badQueue).toMatchObject({ ok: false, field: 'address' });
  });
});

describe('the patch an edit sends', () => {
  test('a form nobody touched sends nothing', () => {
    expect(patchBodyOf(http, fieldsOfDestination(http))).toEqual({ ok: true, patch: {} });
    expect(patchBodyOf(queue, fieldsOfDestination(queue))).toEqual({ ok: true, patch: {} });
  });

  test('only the key that changed is sent, and the address key fits the kind', () => {
    expect(patchBodyOf(http, { ...fieldsOfDestination(http), name: 'Payments' })).toEqual({
      ok: true,
      patch: { name: 'Payments' },
    });
    expect(
      patchBodyOf(http, { ...fieldsOfDestination(http), address: 'https://new.test/hook' })
    ).toEqual({ ok: true, patch: { url: 'https://new.test/hook' } });
    expect(patchBodyOf(queue, { ...fieldsOfDestination(queue), address: 'refunds-v2' })).toEqual({
      ok: true,
      patch: { target: 'refunds-v2' },
    });
  });

  test('the kind is fixed: a form that says otherwise is judged by the destination’s kind', () => {
    const wrong = { ...fieldsOfDestination(http), kind: 'queue' as const, address: 'refunds' };
    expect(patchBodyOf(http, wrong)).toMatchObject({ ok: false, field: 'address' });
  });

  test('an invalid edit is refused with the field, and nothing is built', () => {
    expect(patchBodyOf(http, { ...fieldsOfDestination(http), name: '' })).toMatchObject({
      ok: false,
      field: 'name',
    });
    expect(patchBodyOf(http, { ...fieldsOfDestination(http), address: 'nope' })).toMatchObject({
      ok: false,
      field: 'address',
    });
  });
});

test('the address of a destination is its url or its queue', () => {
  expect(addressOf(http)).toBe('https://billing.test/hook');
  expect(addressOf(queue)).toBe('refunds');
});
