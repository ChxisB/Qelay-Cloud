import { describe, expect, test } from 'bun:test';
import {
  parseReplayPayload,
  parseRequestDetailPayload,
  parseRequestsPayload,
  parseSourceIssuedPayload,
  parseSourcesPayload,
} from '../src/lib/sourcePayloads';
import { inboundRequest, requestDetail, source } from './gateway-sources.helpers';

const ok = (data: unknown) => ({ ok: true, data });

describe('sources payload', () => {
  test('a list of sources is read whole', () => {
    expect(parseSourcesPayload(ok({ sources: [source()] }))).toEqual([source()]);
  });

  test('an unknown check, a repeated id or a missing field refuses the whole list', () => {
    const bad = [
      source({ verification: { kind: 'oauth', header: null, username: null } }),
      source({ updatedAt: 'now' }),
    ];
    for (const one of bad) {
      expect(() => parseSourcesPayload(ok({ sources: [one] }))).toThrow('Malformed sources');
    }
    expect(() => parseSourcesPayload(ok({ sources: [source(), source()] }))).toThrow(
      'Malformed sources'
    );
    expect(() => parseSourcesPayload({ ok: false })).toThrow('Malformed sources');
  });

  test('a create answers with the token and the secret, a rotation of one with the other left null', () => {
    expect(
      parseSourceIssuedPayload(ok({ source: source(), token: 'qin_x', secret: 's' }))
    ).toMatchObject({ token: 'qin_x', secret: 's' });
    expect(parseSourceIssuedPayload(ok({ source: source() }))).toMatchObject({
      token: null,
      secret: null,
    });
    expect(() => parseSourceIssuedPayload(ok({ source: source(), token: 5 }))).toThrow(
      'Malformed source'
    );
  });
});

describe('requests payload', () => {
  test('a page of requests and its cursor', () => {
    const page = parseRequestsPayload(ok({ requests: [inboundRequest()], next: '8' }));
    expect(page.requests).toHaveLength(1);
    expect(page.next).toBe('8');
  });

  test('a status that is neither, or a cursor that is not an id, is refused', () => {
    expect(() =>
      parseRequestsPayload(ok({ requests: [inboundRequest({ status: 'queued' })], next: null }))
    ).toThrow('Malformed requests');
    expect(() => parseRequestsPayload(ok({ requests: [], next: 'abc' }))).toThrow(
      'Malformed requests'
    );
  });

  test('one request whole, with a body that is text or base64, or none', () => {
    expect(parseRequestDetailPayload(ok({ request: requestDetail() })).body?.encoding).toBe('utf8');
    expect(
      parseRequestDetailPayload(ok({ request: requestDetail({ body: null }) })).body
    ).toBeNull();
    expect(() =>
      parseRequestDetailPayload(
        ok({ request: requestDetail({ body: { encoding: 'hex', data: '', bytes: 0 } }) })
      )
    ).toThrow('Malformed request');
    expect(() =>
      parseRequestDetailPayload(ok({ request: requestDetail({ headers: { a: 1 } }) }))
    ).toThrow('Malformed request');
  });

  test('a replay is two counts', () => {
    expect(parseReplayPayload(ok({ routes: 1, deliveries: 2 }))).toEqual({
      routes: 1,
      deliveries: 2,
    });
    expect(() => parseReplayPayload(ok({ routes: 1 }))).toThrow('Malformed replay');
  });
});
