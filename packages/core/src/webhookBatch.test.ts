import { describe, expect, test } from 'bun:test';
import { UnsupportedOptionError } from './errors';
import {
  batchId,
  buildBatchBody,
  DEFAULT_BATCH_BYTES,
  DEFAULT_BATCH_EVENTS,
  MAX_BATCH_BYTES,
  MAX_BATCH_EVENTS,
  validateBatch,
} from './webhookBatch';
import { MAX_SCHEDULE_CRON_CHARS, validateSchedule } from './webhookSchedule';

const refused = (run: () => unknown, option: string) => {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(UnsupportedOptionError);
    expect((error as UnsupportedOptionError).option).toBe(option);
    return;
  }
  throw new Error(`expected ${option} to be refused`);
};

describe('validateBatch', () => {
  test('fills the defaults, and null or undefined means no batch', () => {
    expect(validateBatch({})).toEqual({
      maxEvents: DEFAULT_BATCH_EVENTS,
      maxBytes: DEFAULT_BATCH_BYTES,
    });
    expect(validateBatch({ maxEvents: 25 })).toEqual({
      maxEvents: 25,
      maxBytes: DEFAULT_BATCH_BYTES,
    });
    expect(validateBatch(null)).toBeNull();
    expect(validateBatch(undefined)).toBeNull();
  });

  test('refuses sizes out of range, non-integers, unknown keys and non-objects', () => {
    refused(() => validateBatch({ maxEvents: 0 }), 'batch');
    refused(() => validateBatch({ maxEvents: MAX_BATCH_EVENTS + 1 }), 'batch');
    refused(() => validateBatch({ maxEvents: 1.5 }), 'batch');
    refused(() => validateBatch({ maxBytes: 1_023 }), 'batch');
    refused(() => validateBatch({ maxBytes: MAX_BATCH_BYTES + 1 }), 'batch');
    refused(() => validateBatch({ maxEvents: '10' }), 'batch');
    refused(() => validateBatch({ size: 10 }), 'batch');
    refused(() => validateBatch([]), 'batch');
    refused(() => validateBatch(7), 'batch');
  });

  test('accepts the limits themselves', () => {
    expect(validateBatch({ maxEvents: 1, maxBytes: 1_024 })).not.toBeNull();
    expect(
      validateBatch({ maxEvents: MAX_BATCH_EVENTS, maxBytes: MAX_BATCH_BYTES })
    ).not.toBeNull();
  });

  test('is refused on a queue route', () => {
    refused(() => validateBatch({ maxEvents: 10 }, 'queue'), 'batch');
    expect(validateBatch(null, 'queue')).toBeNull();
  });
});

describe('validateSchedule', () => {
  test('trims the cron and defaults the zone to UTC', () => {
    expect(validateSchedule({ cron: ' 0 0 * * * ' })).toEqual({
      cron: '0 0 * * *',
      timezone: 'UTC',
    });
    expect(validateSchedule({ cron: '@daily', timezone: 'Europe/London' })).toEqual({
      cron: '@daily',
      timezone: 'Europe/London',
    });
    expect(validateSchedule(null)).toBeNull();
    expect(validateSchedule(undefined)).toBeNull();
  });

  test('refuses a missing or odd cron, an unknown zone, unknown keys and non-objects', () => {
    refused(() => validateSchedule({}), 'schedule');
    refused(() => validateSchedule({ cron: '   ' }), 'schedule');
    refused(() => validateSchedule({ cron: 5 }), 'schedule');
    refused(() => validateSchedule({ cron: 'a\nb' }), 'schedule');
    refused(() => validateSchedule({ cron: 'x'.repeat(MAX_SCHEDULE_CRON_CHARS + 1) }), 'schedule');
    refused(() => validateSchedule({ cron: '@daily', timezone: 'Mars/Olympus' }), 'schedule');
    refused(() => validateSchedule({ cron: '@daily', timezone: 3 }), 'schedule');
    refused(() => validateSchedule({ cron: '@daily', at: 'midnight' }), 'schedule');
    refused(() => validateSchedule('@daily'), 'schedule');
  });
});

describe('batchId', () => {
  test('is the same for the same members in any order, and changes with one more or fewer', async () => {
    const first = await batchId(['1', '2', '3']);
    expect(first).toMatch(/^[0-9a-f]{64}$/u);
    expect(await batchId(['3', '1', '2'])).toBe(first);
    expect(await batchId(['1', '2', '3', '4'])).not.toBe(first);
    expect(await batchId(['1', '2'])).not.toBe(first);
  });

  test('does not run ids together', async () => {
    expect(await batchId(['1', '23'])).not.toBe(await batchId(['12', '3']));
  });
});

describe('buildBatchBody', () => {
  const bytes = (text: string) => new TextEncoder().encode(text);

  test('nests JSON, carries other text as a string, and bytes that are not text as base64', async () => {
    const body = JSON.parse(
      await buildBatchBody([
        {
          id: '1',
          receivedAt: 10,
          body: bytes('{"id":500,"name":"chris"}'),
          contentType: 'application/json',
        },
        { id: '2', receivedAt: 20, body: bytes('plain words'), contentType: 'text/plain' },
        { id: '3', receivedAt: 30, body: new Uint8Array([0xff, 0xfe, 0x00]), contentType: null },
        { id: '4', receivedAt: 40, body: '{"shaped":true}', contentType: null },
        { id: '5', receivedAt: 50, body: new Uint8Array(), contentType: 'application/json' },
        { id: '6', receivedAt: 60, body: null, contentType: null },
      ])
    );
    expect(body.count).toBe(6);
    expect(body.batchId).toBe(await batchId(['1', '2', '3', '4', '5', '6']));
    expect(body.events).toEqual([
      { id: '1', receivedAt: 10, body: { id: 500, name: 'chris' } },
      { id: '2', receivedAt: 20, body: 'plain words' },
      { id: '3', receivedAt: 30, body: { base64: '//4A' } },
      { id: '4', receivedAt: 40, body: { shaped: true } },
      { id: '5', receivedAt: 50, body: null },
      { id: '6', receivedAt: 60, body: null },
    ]);
  });

  test('carries JSON content that does not parse as the text it is', async () => {
    const body = JSON.parse(
      await buildBatchBody([
        { id: '1', receivedAt: 1, body: bytes('{broken'), contentType: 'application/json' },
      ])
    );
    expect(body.events[0].body).toBe('{broken');
  });

  test('does not read a text body as JSON because it looks like JSON', async () => {
    const body = JSON.parse(
      await buildBatchBody([
        { id: '1', receivedAt: 1, body: bytes('{"a":1}'), contentType: 'text/plain' },
      ])
    );
    expect(body.events[0].body).toBe('{"a":1}');
  });

  test('takes a large binary body without overflowing the stack', async () => {
    const big = new Uint8Array(262_144).fill(0xff);
    const body = JSON.parse(
      await buildBatchBody([{ id: '1', receivedAt: 1, body: big, contentType: null }])
    );
    expect(body.events[0].body.base64.length).toBe(Math.ceil(262_144 / 3) * 4);
  });

  test('is the same text for the same events, so a retry signs the same bytes', async () => {
    const events = [
      { id: '1', receivedAt: 1, body: bytes('{"a":1}'), contentType: 'application/json' },
    ];
    expect(await buildBatchBody(events)).toBe(await buildBatchBody(events));
  });
});
