import { describe, expect, test } from 'bun:test';
import { demoApiResponse } from '../src/lib/demo/api';
import {
  parseReplayPayload,
  parseRequestDetailPayload,
  parseRequestsPayload,
  parseSourcesPayload,
} from '../src/lib/sourcePayloads';

// The demo answers go through the screens' own parsers, so a demo that drifts from the wire fails here.
describe('demo sources and requests', () => {
  test('the demo source is the one the demo connection reads', () => {
    const sources = parseSourcesPayload(demoApiResponse('/sources', 'GET', ''));
    expect(sources.map((one) => one.id)).toContain('src_demo');
  });

  test('requests filter by status and by source, and one opens with its events', () => {
    const all = parseRequestsPayload(demoApiResponse('/requests', 'GET', ''));
    expect(all.requests).toHaveLength(3);
    const refused = parseRequestsPayload(demoApiResponse('/requests', 'GET', '?status=rejected'));
    expect(refused.requests.map((one) => one.cause)).toEqual(['the signature did not match']);
    expect(
      parseRequestsPayload(demoApiResponse('/requests', 'GET', '?source=src_partner')).requests
    ).toEqual([]);
    const one = parseRequestDetailPayload(demoApiResponse('/requests/4821', 'GET', ''));
    expect(one.deliveries.map((delivery) => delivery.via)).toEqual(['http']);
    expect(one.body?.data).toBe('{"id":500,"name":"chris"}');
  });

  test('a replay answers with counts', () => {
    expect(parseReplayPayload(demoApiResponse('/requests/4821/replay', 'POST', ''))).toEqual({
      routes: 1,
      deliveries: 1,
    });
  });
});
