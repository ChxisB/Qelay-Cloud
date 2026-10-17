import { describe, expect, test } from 'bun:test';
import { SqsTransport } from '@qelay-cloud/transport-aws';
import { PubSubTransport } from '@qelay-cloud/transport-gcp';
import { MemoryTransport, PostgresLocalTransport } from '@qelay-cloud/transport-local';
import type { DeclaredTransport } from '../src';
import { HIDDEN_FEATURES } from '../src';
import { bodyOf, harness } from './support';

const caps = (transport: DeclaredTransport, features = {}) =>
  harness({}, { transport, features }).call('GET', '/capabilities').then(bodyOf);

describe('GET /capabilities matches the declared transport', () => {
  test('memory: unbounded delay is null, not Infinity', async () => {
    const transport = new MemoryTransport();
    const body = await caps({ name: 'memory', capabilities: transport.capabilities });
    expect(body).toMatchObject({
      transport: { name: 'memory', maxDeliverDelayMs: null, ordering: 'none' },
      version: '0.0.0-test',
    });
    await transport.close();
  });

  test('postgres-local: unbounded delay', async () => {
    // The constructor reads only its options; no connection is made until a subscription starts.
    const transport = new PostgresLocalTransport({
      db: {} as never,
      source: {} as never,
      namespace: 'ns',
    });
    const body = await caps({ name: 'postgres-local', capabilities: transport.capabilities });
    expect(body.transport).toEqual({
      name: 'postgres-local',
      maxDeliverDelayMs: null,
      ordering: 'none',
    });
    await transport.close();
  });

  test('gcp-pubsub: no delay at ring time is 0, not null', async () => {
    const transport = new PubSubTransport({
      namespace: 'ns',
      emulatorHost: '127.0.0.1:1',
      projectId: 'p',
    });
    const body = await caps({ name: 'gcp-pubsub', capabilities: transport.capabilities });
    expect(body.transport).toEqual({ name: 'gcp-pubsub', maxDeliverDelayMs: 0, ordering: 'none' });
    await transport.close();
  });

  test('aws-sqs: a 15 minute bound, and no ordering claim', async () => {
    // The constructor reads only its options; no request is made until a ring or a subscription.
    const transport = new SqsTransport({
      namespace: 'ns',
      region: 'eu-west-1',
      endpoint: 'http://127.0.0.1:1',
      monitoring: false,
    });
    const body = await caps({ name: 'aws-sqs', capabilities: transport.capabilities });
    expect(body.transport).toEqual({
      name: 'aws-sqs',
      maxDeliverDelayMs: 900_000,
      ordering: 'none',
    });
    await transport.close();
  });
});

describe('features and hidden pages', () => {
  const memory = { name: 'memory', capabilities: new MemoryTransport().capabilities };

  test('the defaults: dead-letter and cron on, flows, workflows and webhooks off', async () => {
    expect((await caps(memory)).features).toEqual({
      dlq: true,
      cron: true,
      flows: false,
      workflows: false,
      webhooks: false,
    });
  });

  test('the process that enables a feature declares it, and the answer follows', async () => {
    const body = await caps(memory, { flows: true, workflows: true, dlq: false });
    expect(body.features).toEqual({
      dlq: false,
      cron: true,
      flows: true,
      workflows: true,
      webhooks: false,
    });
  });

  test('the Qelay-server-only pages are always hidden', async () => {
    const body = await caps(memory);
    expect(body.hidden).toEqual([
      'serverControl',
      'sqliteDatabase',
      's3Backup',
      'fleet',
      'queueOperations',
    ]);
    expect(body.hidden).toEqual([...HIDDEN_FEATURES]);
  });

  test('it needs a token, and a viewer may read it', async () => {
    const open = harness({}, { transport: memory });
    expect((await open.call('GET', '/capabilities', { token: null })).status).toBe(401);
    const viewer = harness(
      { devToken: { token: 'viewer-token-0123456789-abcdef', role: 'viewer' } },
      { transport: memory }
    );
    expect(
      (await viewer.call('GET', '/capabilities', { token: 'viewer-token-0123456789-abcdef' }))
        .status
    ).toBe(200);
  });

  test('the caller is told its own role, so a client can leave out what it may not do', async () => {
    const api = harness(
      { devToken: { token: 'viewer-token-0123456789-abcdef', role: 'viewer' } },
      { transport: memory }
    );
    const viewer = await bodyOf(
      await api.call('GET', '/capabilities', { token: 'viewer-token-0123456789-abcdef' })
    );
    expect(viewer.principal).toEqual({ role: 'viewer' });
    const operator = await bodyOf(
      await harness({}, { transport: memory }).call('GET', '/capabilities')
    );
    expect(operator.principal).toEqual({ role: 'operator' });
  });

  test('the version is the one the service was built with', async () => {
    const api = harness({ version: '9.8.7' }, { transport: memory });
    expect((await bodyOf(await api.call('GET', '/capabilities'))).version).toBe('9.8.7');
  });
});
