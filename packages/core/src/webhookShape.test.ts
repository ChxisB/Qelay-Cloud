import { describe, expect, test } from 'bun:test';
import { UnsupportedOptionError } from './errors';
import type { WebhookSubject } from './webhookFilter';
import {
  MAX_REF_CHARS,
  MAX_SHAPE_NODES,
  MAX_SHAPED_BODY_BYTES,
  previewWebhook,
  renderShape,
  validateShape,
} from './webhookShape';

const subject: WebhookSubject = {
  event: 'job.failed',
  queue: 'emails',
  jobId: 'j1',
  occurredAt: 5_000,
  state: 'failed',
  error: 'timeout',
};

describe('webhook shape', () => {
  test('picks, renames, defaults and keeps literals', () => {
    const shape = validateShape({
      text: 'Job failed',
      job: { id: { $: 'jobId' }, queue: { $: 'queue' } },
      why: { $: 'error', default: 'unknown' },
      pct: { $: 'progress', default: 0 },
      gone: { $: 'progress' },
      list: [{ $: 'state' }, { $: 'progress' }, 7],
    });
    const rendered = renderShape(shape, subject);
    expect(rendered.ok && JSON.parse(rendered.body)).toEqual({
      text: 'Job failed',
      job: { id: 'j1', queue: 'emails' },
      why: 'timeout',
      pct: 0,
      list: ['failed', null, 7],
    });
  });

  test('keys come out shortest first, then alphabetically, as jsonb stores them', () => {
    const shape = validateShape({ zeta: 1, b: { yy: 1, x: 2 }, alpha: 3, a: 4 });
    const rendered = renderShape(shape, subject);
    expect(rendered.ok && rendered.body).toBe('{"a":4,"b":{"x":2,"yy":1},"zeta":1,"alpha":3}');
  });

  test('a key named __proto__ stays data', () => {
    const shape = validateShape(JSON.parse('{"__proto__": {"$": "queue"}}'));
    const rendered = renderShape(shape, subject);
    expect(rendered.ok && rendered.body).toBe('{"__proto__":"emails"}');
  });

  test('a long text from the event is cut, and a body past the cap is refused', () => {
    const long = { ...subject, error: 'e'.repeat(2_000) };
    const cut = renderShape(validateShape({ e: { $: 'error' } }), long);
    expect(cut.ok && JSON.parse(cut.body).e.length).toBe(MAX_REF_CHARS);
    const refs = Object.fromEntries(
      Array.from({ length: 90 }, (_, i) => [`k${i}`, { $: 'error' }])
    );
    const control = { ...subject, error: '\u0001'.repeat(MAX_REF_CHARS) };
    const big = renderShape(validateShape(refs), control);
    expect(big).toEqual({
      ok: false,
      error: `shaped body is larger than ${MAX_SHAPED_BODY_BYTES} bytes`,
    });
  });

  test.each([
    ['not an object', 'x'],
    ['empty', {}],
    ['a bare reference', { $: 'queue' }],
    ['an unknown field', { a: { $: 'data' } }],
    ['a reserved key', { $set: 1 }],
    ['an extra reference key', { a: { $: 'queue', other: 1 } }],
    ['a bad default', { a: { $: 'queue', default: {} } }],
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
  test('says whether the filter lets the event through, and the body it would send', () => {
    const hit = previewWebhook(
      { filter: { queue: 'emails' }, shape: { q: { $: 'queue' } } },
      subject
    );
    expect(hit).toEqual({ matches: true, body: '{"q":"emails"}', error: null });
    expect(previewWebhook({ filter: { queue: 'other' } }, subject)).toEqual({
      matches: false,
      body: null,
      error: null,
    });
    const plain = previewWebhook({}, subject);
    expect(JSON.parse(plain.body!)).toEqual({
      event: 'job.failed',
      timestamp: 5_000,
      queue: 'emails',
      jobId: 'j1',
      state: 'failed',
      error: 'timeout',
    });
  });
});
