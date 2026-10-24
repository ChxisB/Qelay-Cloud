import { describe, expect, test } from 'bun:test';
import type { WebhookFull } from '../src/lib/bqTypes';
import {
  blankFields,
  DESCRIPTION_MAX,
  fieldsOf,
  NAME_MAX,
  patchOf,
  previewOf,
  rulesOf,
} from '../src/pages/control/gateway/connectionPatch';
import { route } from './gateway.helpers';

const wire = (over: Record<string, unknown> = {}) =>
  ({
    name: null,
    description: null,
    delayMs: null,
    dedupe: null,
    ...route(over),
  }) as unknown as WebhookFull;

/** The patch for a change to the form's values, or the message that refuses it. */
const patch = (over: Record<string, unknown>, change: Partial<ReturnType<typeof fieldsOf>>) => {
  const was = wire(over);
  return patchOf(was, { ...fieldsOf(was), ...change });
};

describe('the patch an edit makes', () => {
  test('a form nobody touched sends nothing', () => {
    expect(patch({}, {})).toEqual({ ok: true, patch: {} });
    const rich = {
      name: 'Billing',
      filter: { queue: 'emails' },
      shape: { id: { $: 'jobId' } },
      delayMs: 5_000,
      dedupe: { windowMs: 60_000, fields: ['body.id', 'method'] },
    };
    expect(patch(rich, {})).toEqual({ ok: true, patch: {} });
  });

  test('only the keys that changed are sent, and an emptied box clears its rule', () => {
    expect(patch({}, { name: '  Billing ' })).toEqual({ ok: true, patch: { name: 'Billing' } });
    expect(patch({ name: 'Billing' }, { name: ' ' })).toEqual({ ok: true, patch: { name: null } });
    expect(patch({ description: 'old' }, { description: 'new' })).toEqual({
      ok: true,
      patch: { description: 'new' },
    });
    expect(patch({ filter: { queue: 'a' } }, { filter: '' })).toEqual({
      ok: true,
      patch: { filter: null },
    });
    expect(patch({ shape: null }, { shape: '{ "id": { "$": "jobId" } }' })).toEqual({
      ok: true,
      patch: { shape: { id: { $: 'jobId' } } },
    });
  });

  test('a name and a description past their limits are refused with the field named', () => {
    expect(patch({}, { name: 'x'.repeat(NAME_MAX + 1) })).toMatchObject({
      ok: false,
      field: 'name',
    });
    expect(patch({}, { name: 'x'.repeat(NAME_MAX) }).ok).toBe(true);
    expect(patch({}, { description: 'x'.repeat(DESCRIPTION_MAX + 1) })).toMatchObject({
      ok: false,
      field: 'description',
    });
  });

  test("a filter or shape must be a JSON object; its grammar is the server's to judge", () => {
    for (const bad of ['{', '[1]', '5', 'null', '"text"']) {
      expect(patch({}, { filter: bad }), bad).toMatchObject({ ok: false, field: 'filter' });
      expect(patch({}, { shape: bad }), bad).toMatchObject({ ok: false, field: 'shape' });
    }
    expect(patch({}, { filter: '{ "queue": { "$regex": "x" } }' }).ok).toBe(true);
  });

  test('a filter typed the same with other spacing is not a change', () => {
    const was = { filter: { queue: 'a', state: 'failed' } };
    expect(patch(was, { filter: '{"queue":"a","state":"failed"}' })).toEqual({
      ok: true,
      patch: {},
    });
  });

  test('a delay is seconds from 1 to 3600, sent as milliseconds', () => {
    expect(patch({}, { delay: '90' })).toEqual({ ok: true, patch: { delayMs: 90_000 } });
    expect(patch({}, { delay: '1.5' })).toEqual({ ok: true, patch: { delayMs: 1_500 } });
    expect(patch({ delayMs: 5_000 }, { delay: '' })).toEqual({
      ok: true,
      patch: { delayMs: null },
    });
    expect(patch({ delayMs: 5_000 }, { delay: '5' })).toEqual({ ok: true, patch: {} });
    for (const bad of ['0', '0.5', '3601', '-1', 'soon', 'NaN', 'Infinity']) {
      expect(patch({}, { delay: bad }), bad).toMatchObject({ ok: false, field: 'delay' });
    }
    expect(patch({}, { delay: '3600' }).ok).toBe(true);
  });

  test('dedupe needs a window of 1 to 86400 seconds and at least one field', () => {
    expect(
      patch({}, { dedupeWindow: '3600', dedupeFields: 'body.id, ,headers.x-id, body.id' })
    ).toEqual({
      ok: true,
      patch: { dedupe: { windowMs: 3_600_000, fields: ['body.id', 'headers.x-id'] } },
    });
    expect(patch({}, { dedupeWindow: '60', dedupeFields: ' , ' })).toMatchObject({
      ok: false,
      field: 'dedupeFields',
    });
    for (const bad of ['0', '86401', 'x']) {
      expect(patch({}, { dedupeWindow: bad }), bad).toMatchObject({
        ok: false,
        field: 'dedupeWindow',
      });
    }
    expect(patch({}, { dedupeWindow: '86400' }).ok).toBe(true);
  });

  test('dedupe is cleared by an empty window, left alone when unchanged, and not cleared twice', () => {
    const has = { dedupe: { windowMs: 60_000, fields: ['body.id', 'method'] } };
    expect(patch(has, { dedupeWindow: '' })).toEqual({ ok: true, patch: { dedupe: null } });
    expect(patch(has, { dedupeFields: 'method,body.id' })).toEqual({ ok: true, patch: {} });
    expect(patch(has, { dedupeFields: 'method' })).toEqual({
      ok: true,
      patch: { dedupe: { windowMs: 60_000, fields: ['method'] } },
    });
    expect(patch({}, { dedupeWindow: '' })).toEqual({ ok: true, patch: {} });
  });

  test('the first field that cannot be sent is the one named, and nothing is sent for the rest', () => {
    expect(patch({}, { name: 'x'.repeat(NAME_MAX + 1), delay: '0' })).toMatchObject({
      ok: false,
      field: 'name',
    });
  });
});

describe('the preview of a patch', () => {
  test('is empty for nothing and the request for something', () => {
    expect(previewOf('hook-1', {})).toBe('');
    expect(previewOf('hook-1', { name: 'Billing', delayMs: null })).toBe(
      'PATCH /webhooks/hook-1\n{\n  "name": "Billing",\n  "delayMs": null\n}'
    );
  });
});

describe('the rules a new connection sends', () => {
  test('a form nobody touched sends no rules', () => {
    expect(rulesOf(blankFields())).toEqual({ ok: true, rules: {} });
  });

  test('only what was typed is sent, with the same units and limits as an edit', () => {
    const typed = rulesOf({
      ...blankFields(),
      name: ' Billing ',
      filter: '{ "body.kind": "invoice" }',
      delay: '90',
      dedupeWindow: '60',
    });
    expect(typed).toEqual({
      ok: true,
      rules: {
        name: 'Billing',
        filter: { 'body.kind': 'invoice' },
        delayMs: 90_000,
        dedupe: { windowMs: 60_000, fields: ['body.id'] },
      },
    });
  });

  test('a rule typed wrongly is refused with its field', () => {
    expect(rulesOf({ ...blankFields(), shape: '[1]' })).toMatchObject({
      ok: false,
      field: 'shape',
    });
    expect(rulesOf({ ...blankFields(), delay: '7200' })).toMatchObject({
      ok: false,
      field: 'delay',
    });
  });
});
