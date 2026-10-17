import { afterEach, beforeEach, expect, test } from 'bun:test';
import { TransportError } from '@qelay-cloud/core';
import { PubSubTransport } from '../src';

/**
 * A `PUBSUB_EMULATOR_HOST` that leaks into a deployment makes the Google client talk to a dead address
 * and no error: the bells are lost to the broker and the tick re-rings them late. The transport refuses
 * the variable unless the emulator was asked for in code. No emulator is needed: only construction.
 */
const KEY = 'PUBSUB_EMULATOR_HOST';
let before: string | undefined;

beforeEach(() => {
  before = process.env[KEY];
  process.env[KEY] = '127.0.0.1:1';
});
afterEach(() => {
  if (before === undefined) delete process.env[KEY];
  else process.env[KEY] = before;
});

test('refuses PUBSUB_EMULATOR_HOST when the emulator was not asked for in code', () => {
  expect(() => new PubSubTransport({ namespace: 'guard' })).toThrow(TransportError);
  expect(() => new PubSubTransport({ namespace: 'guard' })).toThrow(KEY);
});

test('an explicit emulatorHost is the way to use an emulator', async () => {
  const transport = new PubSubTransport({ namespace: 'guard', emulatorHost: '127.0.0.1:1' });
  await transport.close();
});

test('without the variable the transport builds its client as before', async () => {
  delete process.env[KEY];
  const transport = new PubSubTransport({ namespace: 'guard', projectId: 'guard-project' });
  await transport.close();
});
