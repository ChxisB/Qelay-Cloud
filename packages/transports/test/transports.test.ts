import { describe, expect, test } from 'bun:test';
import { UnsupportedOptionError } from '@qelay-cloud/core';
import type { LocalDatabase, QueueSource } from '@qelay-cloud/transport-local';
import {
  DEFAULT_TRANSPORT_KIND,
  describeTransport,
  openTransport,
  TRANSPORT_KINDS,
  transportSettingsFromEnv,
} from '../src';

/** A database and a source that nothing connects to: building a transport must not touch either. */
const local = {
  db: {
    run: async () => {
      throw new Error('not connected');
    },
    openListener: () => {
      throw new Error('not connected');
    },
  } satisfies LocalDatabase,
  source: {
    hasClaimable: async () => false,
    snapshot: async () => {
      throw new Error('not connected');
    },
  } satisfies QueueSource,
};

describe('transportSettingsFromEnv', () => {
  test('defaults to Pub/Sub, with nothing else set', () => {
    expect(DEFAULT_TRANSPORT_KIND).toBe('gcp-pubsub');
    expect(transportSettingsFromEnv({})).toEqual({
      transport: 'gcp-pubsub',
      projectId: undefined,
      region: undefined,
      endpoint: undefined,
    });
  });

  test('reads each broker its own variables, and treats an empty one as unset', () => {
    expect(
      transportSettingsFromEnv({
        QCLOUD_TRANSPORT: 'aws-sqs',
        QCLOUD_AWS_REGION: 'eu-west-2',
        QCLOUD_AWS_SQS_ENDPOINT: 'http://127.0.0.1:59324',
        QCLOUD_GCP_PROJECT: '',
      })
    ).toEqual({
      transport: 'aws-sqs',
      projectId: undefined,
      region: 'eu-west-2',
      endpoint: 'http://127.0.0.1:59324',
    });
  });

  test('refuses an unknown broker by variable name, never repeating the value', () => {
    const attempt = () => transportSettingsFromEnv({ QCLOUD_TRANSPORT: 'rabbitmq-secret-value' });
    expect(attempt).toThrow(UnsupportedOptionError);
    expect(attempt).toThrow(/QCLOUD_TRANSPORT/);
    expect(attempt).not.toThrow(/secret-value/);
  });

  test('SQS needs an explicit region: it is never read from the machine', () => {
    const attempt = () => transportSettingsFromEnv({ QCLOUD_TRANSPORT: 'aws-sqs' });
    expect(attempt).toThrow(UnsupportedOptionError);
    expect(attempt).toThrow(/QCLOUD_AWS_REGION/);
  });
});

describe('openTransport', () => {
  const settings = (transport: (typeof TRANSPORT_KINDS)[number]) => ({
    transport,
    projectId: 'p',
    region: 'us-east-1',
    endpoint: undefined,
  });

  test('builds each broker, and the broker is told only by what it declares', async () => {
    const windows: Record<string, number> = {};
    for (const kind of TRANSPORT_KINDS) {
      const transport = openTransport(settings(kind), { namespace: 'ns', local });
      windows[kind] = transport.capabilities.maxDeliverDelayMs;
      await transport.close();
    }
    expect(windows).toEqual({
      'gcp-pubsub': 0,
      'aws-sqs': 900_000,
      postgres: Number.POSITIVE_INFINITY,
    });
  });

  test('the Postgres transport needs a database to poll', () => {
    expect(() => openTransport(settings('postgres'), { namespace: 'ns' })).toThrow(/needs `local`/);
  });
});

describe('describeTransport', () => {
  test('names every broker, and says which keep a dead-letter queue of bells', () => {
    expect(TRANSPORT_KINDS.map((kind) => describeTransport(kind))).toEqual([
      { name: 'gcp-pubsub', doorbellDeadLetter: true, approximateCounts: false },
      { name: 'aws-sqs', doorbellDeadLetter: true, approximateCounts: true },
      { name: 'postgres-local', doorbellDeadLetter: false, approximateCounts: false },
    ]);
  });
});
