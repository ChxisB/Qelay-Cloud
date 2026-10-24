import { describe, expect, test } from 'bun:test';
import type { WebhookFull } from '../src/lib/bqTypes';
import { filterRoutes, routeLine, routeName, ruleChips } from '../src/pages/control/gateway/model';
import { route } from './gateway.helpers';

const wire = (over: Record<string, unknown> = {}) => route(over) as unknown as WebhookFull;

describe('ruleChips', () => {
  test('names only the rules a connection has, and Signed for a signed address', () => {
    expect(ruleChips(wire())).toEqual(['Signed']);
    expect(ruleChips(wire({ signed: false }))).toEqual([]);
    expect(ruleChips(wire({ filter: { queue: 'a' }, shape: { id: 'x' } }))).toEqual([
      'Filter',
      'Reshaped',
      'Signed',
    ]);
  });

  test('a queue route is never Signed', () => {
    const queue = wire({ destination: 'queue', url: '', target: 'refunds', signed: true });
    expect(ruleChips(queue)).toEqual([]);
  });
});

describe("a connection's name", () => {
  test('is what it is called, and without one the address it sends to', () => {
    expect(routeName(wire())).toBe('https://receiver.test/hook');
    expect(routeName(wire({ name: 'Orders to billing' }))).toBe('Orders to billing');
    expect(routeLine(wire())).toBe('Source: src_1 → https://receiver.test/hook');
    expect(routeLine(wire({ name: 'Orders to billing' }))).toBe(
      'Orders to billing: Source: src_1 → https://receiver.test/hook'
    );
  });

  test('delay and dedupe are rules', () => {
    expect(ruleChips(wire({ signed: false, delayMs: 5_000 }))).toEqual(['Delay']);
    expect(
      ruleChips(wire({ signed: false, dedupe: { windowMs: 1_000, fields: ['event'] } }))
    ).toEqual(['Deduplicated']);
    expect(ruleChips(wire({ signed: false, delayMs: 0 }))).toEqual([]);
  });
});

describe('filterRoutes', () => {
  const routes = [
    wire({ id: 'a' }),
    wire({ id: 'b', destination: 'queue', url: '', target: 'refunds', source: 'orders' }),
    wire({
      id: 'c',
      enabled: false,
      disabledReason: 'failing',
      pausedBy: 'failures',
      url: 'https://other.test/x',
    }),
    wire({ id: 'd', enabled: false }),
    wire({
      id: 'e',
      enabled: false,
      disabledReason: 'paused by an operator',
      pausedBy: 'operator',
    }),
  ];
  const ids = (found: readonly WebhookFull[]) => found.map((item) => item.id);

  test('no text and any state keeps every connection', () => {
    expect(ids(filterRoutes(routes, { text: '', state: 'all' }))).toEqual([
      'a',
      'b',
      'c',
      'd',
      'e',
    ]);
  });

  test('text matches the id, the source and the shown destination, ignoring case and spaces', () => {
    expect(ids(filterRoutes(routes, { text: ' REFUNDS ', state: 'all' }))).toEqual(['b']);
    expect(ids(filterRoutes(routes, { text: 'orders', state: 'all' }))).toEqual(['b']);
    expect(ids(filterRoutes(routes, { text: 'other.test', state: 'all' }))).toEqual(['c']);
    expect(ids(filterRoutes(routes, { text: 'D', state: 'all' }))).toContain('d');
  });

  test('state separates a disabled connection, one an operator paused and one paused after failures', () => {
    expect(ids(filterRoutes(routes, { text: '', state: 'active' }))).toEqual(['a', 'b']);
    expect(ids(filterRoutes(routes, { text: '', state: 'paused' }))).toEqual(['c']);
    expect(ids(filterRoutes(routes, { text: '', state: 'held' }))).toEqual(['e']);
    expect(ids(filterRoutes(routes, { text: '', state: 'off' }))).toEqual(['d']);
  });

  test('text and state both apply', () => {
    expect(ids(filterRoutes(routes, { text: 'refunds', state: 'paused' }))).toEqual([]);
  });
});
