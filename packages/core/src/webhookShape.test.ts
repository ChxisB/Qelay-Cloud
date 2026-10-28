import { describe, expect, test } from 'bun:test';
import { UnsupportedOptionError } from './errors';
import {
  MAX_SHAPE_NODES,
  MAX_SHAPED_BODY_BYTES,
  previewRequest,
  renderShape,
  validateShape,
} from './webhookShape';

/** A request document (DESIGN.md D14). */
const request = {
  method: 'POST',
  headers: { 'x-event': 'order.failed' },
  query: {},
  body: { id: 'j1', queue: 'emails', state: 'failed', error: 'timeout' },
};

describe('webhook shape', () => {
  test('picks, renames, defaults and keeps literals', () => {
    const shape = validateShape({
      text: 'Order failed',
      job: { id: { $: 'body.id' }, queue: { $: 'body.queue' } },
      why: { $: 'body.error', default: 'unknown' },
      pct: { $: 'body.progress', default: 0 },
      gone: { $: 'body.progress' },
      list: [{ $: 'body.state' }, { $: 'body.progress' }, 7],
    });
    const rendered = renderShape(shape, request);
    expect(rendered.ok && JSON.parse(rendered.body)).toEqual({
      text: 'Order failed',
      job: { id: 'j1', queue: 'emails' },
      why: 'timeout',
      pct: 0,
      list: ['failed', null, 7],
    });
  });

  test('keys come out shortest first, then alphabetically, as jsonb stores them', () => {
    const shape = validateShape({ zeta: 1, b: { yy: 1, x: 2 }, alpha: 3, a: 4 });
    const rendered = renderShape(shape, request);
    expect(rendered.ok && rendered.body).toBe('{"a":4,"b":{"x":2,"yy":1},"zeta":1,"alpha":3}');
  });

  test('a key named __proto__ stays data', () => {
    const shape = validateShape(JSON.parse('{"__proto__": {"$": "body.queue"}}'));
    const rendered = renderShape(shape, request);
    expect(rendered.ok && rendered.body).toBe('{"__proto__":"emails"}');
  });

  test('a body past the cap is refused', () => {
    const refs = Object.fromEntries(
      Array.from({ length: 90 }, (_, i) => [`k${i}`, { $: 'body.error' }])
    );
    const control = { body: { error: '\u0001'.repeat(512) } };
    expect(renderShape(validateShape(refs), control)).toEqual({
      ok: false,
      error: `shaped body is larger than ${MAX_SHAPED_BODY_BYTES} bytes`,
    });
  });

  test.each([
    ['not an object', 'x'],
    ['empty', {}],
    ['a bare reference', { $: 'body.queue' }],
    ['an unknown root', { a: { $: 'data' } }],
    ['a bare name that is no root', { a: { $: 'queue' } }],
    ['a reserved key', { $set: 1 }],
    ['an extra reference key', { a: { $: 'body.queue', other: 1 } }],
    ['a bad default', { a: { $: 'body.queue', default: {} } }],
    [
      'too many values',
      Object.fromEntries(Array.from({ length: MAX_SHAPE_NODES }, (_, i) => [`k${i}`, 1])),
    ],
    ['too deep', { a: { b: { c: { d: { e: { f: { g: 1 } } } } } } }],
  ])('refuses %s', (_name, shape) => {
    expect(() => validateShape(shape)).toThrow(UnsupportedOptionError);
  });
});

describe('webhook preview', () => {
  test('says whether the filter lets the request through, and the body it would send', () => {
    const hit = previewRequest(
      { filter: { 'body.queue': 'emails' }, shape: { q: { $: 'body.queue' } } },
      request
    );
    expect(hit).toEqual({ matches: true, body: '{"q":"emails"}', error: null });
    expect(previewRequest({ filter: { 'body.queue': 'other' } }, request)).toEqual({
      matches: false,
      body: null,
      error: null,
    });
    expect(JSON.parse(previewRequest({}, request).body!)).toEqual(request.body);
  });
});
