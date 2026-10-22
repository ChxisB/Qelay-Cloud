import { describe, expect, test } from 'bun:test';
import type { RouteEdge } from './webhookRoute';
import { isWebhookDestination, MAX_ROUTE_CHAIN, routeProblem } from './webhookRoute';

/** `a>b, b>c` as edges. */
const edges = (spec: string): RouteEdge[] =>
  spec === ''
    ? []
    : spec.split(',').map((pair) => {
        const [from, to] = pair.trim().split('>');
        return { from: from!, to: to! };
      });

/** q0>q1, q1>q2, … with `n` routes. */
const chain = (n: number): RouteEdge[] =>
  Array.from({ length: n }, (_, i) => ({ from: `q${i}`, to: `q${i + 1}` }));

describe('routeProblem', () => {
  test('no routes, one route, a fan-out and a diamond are fine', () => {
    expect(routeProblem([])).toBeNull();
    expect(routeProblem(edges('a>b'))).toBeNull();
    expect(routeProblem(edges('a>b, a>c, a>d'))).toBeNull();
    expect(routeProblem(edges('a>b, a>c, b>d, c>d'))).toBeNull();
  });

  test('a route from a queue to itself is a cycle', () => {
    expect(routeProblem(edges('a>a'))).toBe('cycle');
  });

  test('a loop of two or of three queues is a cycle, wherever the walk starts', () => {
    expect(routeProblem(edges('a>b, b>a'))).toBe('cycle');
    expect(routeProblem(edges('x>a, a>b, b>c, c>a'))).toBe('cycle');
    expect(routeProblem(edges('c>a, b>c, a>b'))).toBe('cycle');
  });

  test('a chain of five routes is fine and six is too long', () => {
    expect(MAX_ROUTE_CHAIN).toBe(5);
    expect(routeProblem(chain(5))).toBeNull();
    expect(routeProblem(chain(6))).toBe('chain');
  });

  test('the longest path counts, not the number of routes', () => {
    const wide = edges('a>b, a>c, a>d, a>e, a>f, a>g, a>h');
    expect(routeProblem(wide)).toBeNull();
    expect(routeProblem([...chain(5), ...edges('q5>z1, q2>z2')])).toBe('chain');
  });

  test('a cycle is reported before a chain', () => {
    expect(routeProblem([...chain(6), { from: 'q6', to: 'q0' }])).toBe('cycle');
  });
});

describe('isWebhookDestination', () => {
  test('knows http and queue only', () => {
    expect(isWebhookDestination('http')).toBe(true);
    expect(isWebhookDestination('queue')).toBe(true);
    expect(isWebhookDestination('workflow')).toBe(false);
    expect(isWebhookDestination(undefined)).toBe(false);
  });
});
