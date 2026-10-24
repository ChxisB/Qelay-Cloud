import { describe, expect, test } from 'bun:test';
import { BqError } from '../src/lib/bq';
import type { WebhookFull } from '../src/lib/bqTypes';
import { parseWebhooksPayload } from '../src/lib/dashboardPayloads';
import {
  blankFields,
  fieldsOf,
  patchOf,
  refusedField,
  rulesOf,
} from '../src/pages/control/gateway/connectionPatch';
import { ruleChips } from '../src/pages/control/gateway/model';
import { cronLabel, inZone, sendFieldsOf } from '../src/pages/control/gateway/sendRules';
import { route } from './gateway.helpers';

const NIGHTLY = { cron: '0 0 * * *', timezone: 'Europe/London' };
const wire = (over: Record<string, unknown> = {}) =>
  ({ name: null, description: null, ...route(over) }) as unknown as WebhookFull;
const patch = (over: Record<string, unknown>, change: Partial<ReturnType<typeof fieldsOf>>) => {
  const was = wire(over);
  return patchOf(was, { ...fieldsOf(was), ...change });
};

describe('a route payload with a send schedule and a batch', () => {
  const hook = (over: Record<string, unknown> = {}) =>
    parseWebhooksPayload({
      ok: true,
      data: {
        webhooks: [
          {
            id: 'h',
            url: 'https://receiver.test/',
            urlRedacted: false,
            source: 'src_1',
            signed: false,
            enabled: true,
            createdAt: 1,
            lastTriggered: null,
            successCount: 0,
            failureCount: 0,
            ...over,
          },
        ],
      },
    }).data.webhooks[0];

  test('keeps them, with the next send time the server worked out', () => {
    expect(
      hook({
        schedule: NIGHTLY,
        nextSendAt: 1_800_000_000_000,
        batch: { maxEvents: 50, maxBytes: 262_144 },
      })
    ).toMatchObject({
      schedule: NIGHTLY,
      nextSendAt: 1_800_000_000_000,
      batch: { maxEvents: 50, maxBytes: 262_144 },
    });
  });

  test('reads a server that predates them as no schedule and no batch', () => {
    expect(hook()).toMatchObject({ schedule: null, nextSendAt: null, batch: null });
  });

  test.each([
    ['a schedule with no zone', { schedule: { cron: '@daily' } }],
    ['a schedule that is not an object', { schedule: '@daily' }],
    ['a batch of no events', { batch: { maxEvents: 0, maxBytes: 4_096 } }],
    ['a batch with no size', { batch: { maxEvents: 5 } }],
    ['a next send that is not a time', { nextSendAt: 'midnight' }],
  ])('refuses %s', (_label, over) => {
    expect(() => hook(over)).toThrow(/Malformed/);
  });
});

describe('the schedule and batch an edit sends', () => {
  test('a connection with neither sends nothing for them, and shows the defaults', () => {
    expect(patch({}, {})).toEqual({ ok: true, patch: {} });
    expect(sendFieldsOf({ schedule: null, batch: null })).toEqual({
      sendMode: '',
      sendCron: '',
      sendZone: 'UTC',
      batchOn: false,
      batchEvents: '',
      batchKib: '',
    });
  });

  test('a preset or a custom cron is sent with its zone, and only when it changed', () => {
    expect(patch({}, { sendMode: '0 0 * * *', sendZone: 'Europe/London' })).toEqual({
      ok: true,
      patch: { schedule: NIGHTLY },
    });
    expect(
      patch({}, { sendMode: 'custom', sendCron: ' 30 6 * * 1-5 ', sendZone: 'America/New_York' })
    ).toEqual({
      ok: true,
      patch: { schedule: { cron: '30 6 * * 1-5', timezone: 'America/New_York' } },
    });
    expect(patch({ schedule: NIGHTLY }, {})).toEqual({ ok: true, patch: {} });
    // A saved cron that is not a preset opens as custom and is not a change.
    const custom = { cron: '15 3 * * *', timezone: 'UTC' };
    expect(fieldsOf(wire({ schedule: custom }))).toMatchObject({
      sendMode: 'custom',
      sendCron: '15 3 * * *',
    });
    expect(patch({ schedule: custom }, {})).toEqual({ ok: true, patch: {} });
    expect(patch({ schedule: NIGHTLY }, { sendZone: 'UTC' })).toEqual({
      ok: true,
      patch: { schedule: { cron: '0 0 * * *', timezone: 'UTC' } },
    });
  });

  test('sending at once again clears the schedule with null', () => {
    expect(patch({ schedule: NIGHTLY }, { sendMode: '' })).toEqual({
      ok: true,
      patch: { schedule: null },
    });
  });

  test('a custom cron that is empty or too long, or no zone, is refused with its field', () => {
    expect(patch({}, { sendMode: 'custom', sendCron: '  ' })).toMatchObject({
      ok: false,
      field: 'sendCron',
    });
    expect(patch({}, { sendMode: 'custom', sendCron: 'x'.repeat(201) })).toMatchObject({
      ok: false,
      field: 'sendCron',
    });
    expect(patch({}, { sendMode: '0 * * * *', sendZone: ' ' })).toMatchObject({
      ok: false,
      field: 'sendZone',
    });
  });

  test('a batch takes the defaults for empty boxes, and sends KiB as bytes', () => {
    expect(patch({}, { batchOn: true })).toEqual({
      ok: true,
      patch: { batch: { maxEvents: 100, maxBytes: 262_144 } },
    });
    expect(patch({}, { batchOn: true, batchEvents: '20', batchKib: '4' })).toEqual({
      ok: true,
      patch: { batch: { maxEvents: 20, maxBytes: 4_096 } },
    });
    const batched = { batch: { maxEvents: 20, maxBytes: 4_096 } };
    expect(fieldsOf(wire(batched))).toMatchObject({
      batchOn: true,
      batchEvents: '20',
      batchKib: '4',
    });
    expect(patch(batched, {})).toEqual({ ok: true, patch: {} });
    expect(patch(batched, { batchOn: false })).toEqual({ ok: true, patch: { batch: null } });
  });

  test.each([
    ['no events', { batchEvents: '0' }, 'batchEvents'],
    ['too many events', { batchEvents: '501' }, 'batchEvents'],
    ['half an event', { batchEvents: '1.5' }, 'batchEvents'],
    ['under a KiB', { batchKib: '0.5' }, 'batchKib'],
    ['over a MiB', { batchKib: '1025' }, 'batchKib'],
    ['a size that is not a number', { batchKib: 'big' }, 'batchKib'],
  ])('a batch with %s is refused with its field', (_label, change, field) => {
    expect(patch({}, { batchOn: true, ...change })).toMatchObject({ ok: false, field });
  });

  test('batch boxes are ignored while the batch is off', () => {
    expect(patch({}, { batchOn: false, batchEvents: '9999' })).toEqual({ ok: true, patch: {} });
  });
});

describe('the schedule and batch a new connection sends', () => {
  test('nothing typed sends neither, whatever zone the browser is in', () => {
    expect(rulesOf(blankFields())).toEqual({ ok: true, rules: {} });
  });

  test('a nightly schedule and a batch are sent with the rest', () => {
    expect(
      rulesOf({
        ...blankFields(),
        sendMode: '0 0 * * *',
        sendZone: 'Europe/London',
        batchOn: true,
        batchEvents: '50',
      })
    ).toEqual({
      ok: true,
      rules: { schedule: NIGHTLY, batch: { maxEvents: 50, maxBytes: 262_144 } },
    });
  });
});

describe('where a refusal from the server lands', () => {
  const refusal = (option: string) => new BqError('no', 400, 'unsupported_option', { option });

  test('a schedule refusal goes to the cron box and a batch refusal to the events box', () => {
    expect(refusedField(refusal('schedule'))).toBe('sendCron');
    expect(refusedField(refusal('batch'))).toBe('batchEvents');
  });
});

describe('how a schedule reads', () => {
  test('a preset has its label and any other cron is written out', () => {
    expect(cronLabel('0 0 * * *')).toBe('Every night at midnight');
    expect(cronLabel('30 6 * * 1-5')).toBe('Cron 30 6 * * 1-5');
  });

  test('a moment is shown in the schedule zone, not the browser zone', () => {
    const midnight = Date.UTC(2027, 0, 16, 0, 0);
    expect(inZone(midnight, 'Europe/London')).toMatch(/^Sat 16 Jan.*00:00 GMT$/u);
    expect(inZone(midnight, 'Asia/Tokyo')).toMatch(/^Sat 16 Jan.*09:00/u);
    expect(inZone(midnight, 'Mars/Olympus')).toBe('2027-01-16T00:00:00.000Z');
  });

  test('the connection list says it is scheduled and batched', () => {
    expect(
      ruleChips(wire({ schedule: NIGHTLY, batch: { maxEvents: 5, maxBytes: 4_096 } }))
    ).toEqual(['Scheduled', 'Batched', 'Signed']);
  });
});
