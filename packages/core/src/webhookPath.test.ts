import { describe, expect, test } from 'bun:test';
import { isDocumentPath, readPath } from './webhookPath';

const document = {
  method: 'POST',
  headers: { 'x-github-event': 'push' },
  query: { page: '2' },
  body: { id: 500, name: 'chris', items: [{ sku: 'a' }, { sku: 'b' }] },
};

describe('document paths', () => {
  test.each(['method', 'headers.x-github-event', 'query.page', 'body.id', 'body.items.1.sku'])(
    'accepts %s',
    (path) => expect(isDocumentPath(path)).toBe(true)
  );

  test.each([
    ['an unknown root', 'data.id'],
    ['an empty segment', 'body..id'],
    ['a trailing dot', 'body.'],
    ['__proto__', 'body.__proto__.x'],
    ['constructor', 'body.constructor'],
    ['prototype', 'body.prototype'],
    ['a space', 'body.first name'],
    ['too many segments', ['body', ...'abcdefgh'].join('.')],
    ['a long segment', `body.${'x'.repeat(65)}`],
    ['a non-string', 5],
  ])('refuses %s', (_name, path) => expect(isDocumentPath(path)).toBe(false));

  test('reads plain objects and array indexes', () => {
    expect(readPath(document, 'body.id')).toBe(500);
    expect(readPath(document, 'body.name')).toBe('chris');
    expect(readPath(document, 'body.items.1.sku')).toBe('b');
    expect(readPath(document, 'headers.x-github-event')).toBe('push');
  });

  test('a missing path is undefined, and a prototype property is not reachable', () => {
    expect(readPath(document, 'body.nope')).toBeUndefined();
    expect(readPath(document, 'body.items.9.sku')).toBeUndefined();
    expect(readPath(document, 'body.name.length')).toBeUndefined();
    expect(readPath(document, 'body.toString')).toBeUndefined();
    expect(readPath(document, 'body.items.length')).toBeUndefined();
  });
});
