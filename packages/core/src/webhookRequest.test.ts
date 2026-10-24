import { describe, expect, test } from 'bun:test';
import { UnsupportedOptionError } from './errors';
import { matchesFilter, validateFilter } from './webhookFilter';
import { dedupeValues, validateDedupe } from './webhookRules';
import { previewRequest, renderShape, validateShape } from './webhookShape';

/** The event document of a request (DESIGN.md D14). */
const chris = {
  method: 'POST',
  headers: { 'x-event': 'user.created' },
  query: { page: '2' },
  body: { id: 500, name: 'chris', admin: false, tags: ['a', 'b'] },
};

const passes = (filter: unknown, document: Record<string, unknown> = chris): boolean =>
  matchesFilter(validateFilter(filter), document);

describe('filter over a request document', () => {
  test('compares a body path with the type the request holds', () => {
    expect(passes({ 'body.id': { $gt: 100 } })).toBe(true);
    expect(passes({ 'body.id': { $gt: 900 } })).toBe(false);
    expect(passes({ 'body.id': 500, 'body.name': 'chris' })).toBe(true);
    expect(passes({ 'body.id': '500' })).toBe(false);
    expect(passes({ 'body.admin': false })).toBe(true);
    expect(passes({ 'body.name': { $startsWith: 'ch' } })).toBe(true);
    expect(passes({ 'body.tags.1': { $in: ['b', 'c'] } })).toBe(true);
  });

  test('reads headers, the query and the method', () => {
    expect(passes({ 'headers.x-event': 'user.created', 'query.page': '2', method: 'POST' })).toBe(
      true
    );
    expect(passes({ 'headers.x-event': { $in: ['a', 'b'] } })).toBe(false);
  });

  test('a path with no value matches only $exist: false, and null counts as none', () => {
    expect(passes({ 'body.email': 'x' })).toBe(false);
    expect(passes({ 'body.email': { $exist: false } })).toBe(true);
    expect(passes({ 'body.id': { $exist: true } })).toBe(true);
    expect(passes({ 'body.gone': { $exist: false } }, { body: { gone: null } })).toBe(true);
  });

  test('a non-JSON request has no body paths', () => {
    expect(
      passes({ 'body.id': { $exist: false } }, { method: 'POST', headers: {}, query: {} })
    ).toBe(true);
  });

  test.each([
    ['an unknown root', { 'data.id': 1 }],
    ['__proto__', { 'body.__proto__.x': 1 }],
    ['a compare on text', { 'body.id': { $gt: 'a' } }],
    ['an object operand', { 'body.id': { $eq: { a: 1 } } }],
    ['a boolean compare', { 'body.id': { $lt: true } }],
    ['an empty $startsWith', { 'body.id': { $startsWith: '' } }],
    ['a bare name that is no root', { queue: true }],
  ])('refuses %s', (_name, filter) => {
    expect(() => validateFilter(filter)).toThrow(UnsupportedOptionError);
  });
});

describe('shape over a request document', () => {
  test('renames and nests body, header and query values', () => {
    const shape = validateShape({
      who: { $: 'body.name' },
      id: { $: 'body.id' },
      event: { $: 'headers.x-event' },
      note: { $: 'body.note', default: 'none' },
      tags: { $: 'body.tags' },
    });
    const rendered = renderShape(shape, chris);
    expect(rendered).toEqual({
      ok: true,
      body: '{"id":500,"who":"chris","note":"none","tags":["a","b"],"event":"user.created"}',
    });
  });

  test('a long text from the request is not cut', () => {
    const long = 'x'.repeat(2_000);
    const rendered = renderShape(validateShape({ t: { $: 'body.t' } }), { body: { t: long } });
    expect(rendered).toEqual({ ok: true, body: JSON.stringify({ t: long }) });
  });

  test('refuses a path outside the document', () => {
    expect(() => validateShape({ a: { $: 'data.id' } })).toThrow(UnsupportedOptionError);
  });
});

describe('dedupe over a request document', () => {
  test('takes paths, in a fixed order, at most five', () => {
    expect(
      validateDedupe({ windowMs: 60_000, fields: ['body.id', 'headers.x-event', 'body.id'] })
    ).toEqual({ windowMs: 60_000, fields: ['body.id', 'headers.x-event'] });
    const six = ['body.a', 'body.b', 'body.c', 'body.d', 'body.e', 'body.f'];
    expect(() => validateDedupe({ windowMs: 60_000, fields: six })).toThrow(UnsupportedOptionError);
    expect(() => validateDedupe({ windowMs: 60_000, fields: ['body'.concat('.', '')] })).toThrow(
      UnsupportedOptionError
    );
  });

  test('two requests are the same when the chosen paths agree', () => {
    const other = { ...chris, body: { ...chris.body, name: 'sam' } };
    expect(dedupeValues(['body.id'], chris)).toBe(dedupeValues(['body.id'], other));
    expect(dedupeValues(['body.name'], chris)).not.toBe(dedupeValues(['body.name'], other));
    expect(dedupeValues(['body.email'], chris)).toBe('[null]');
  });
});

describe('preview of a request', () => {
  test('with no shape the body goes through unchanged', () => {
    expect(previewRequest({}, chris)).toEqual({
      matches: true,
      body: '{"id":500,"name":"chris","admin":false,"tags":["a","b"]}',
      error: null,
    });
  });

  test('a filter that excludes the request, a shape and a non-JSON request', () => {
    expect(previewRequest({ filter: { 'body.id': 1 } }, chris).matches).toBe(false);
    expect(previewRequest({ shape: { who: { $: 'body.name' } } }, chris).body).toBe(
      '{"who":"chris"}'
    );
    expect(previewRequest({}, { method: 'POST', headers: {}, query: {} }).body).toBeNull();
  });
});
