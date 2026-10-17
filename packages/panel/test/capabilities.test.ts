import { describe, expect, test } from 'bun:test';
import {
  closedFeatureName,
  isActionSupported,
  isConceptHidden,
  isGatedPage,
  isPageAvailable,
  mayOperate,
  needsOperator,
} from '../src/lib/capabilities/model';
import {
  type Capabilities,
  CapabilitiesError,
  DEMO_CAPABILITIES,
  FAIL_CLOSED,
  parseCapabilities,
} from '../src/lib/capabilities/types';

/** What the Control API answers for the GCP deployment: server concepts hidden, flows off. */
const CLOUD: Capabilities = {
  transport: { name: 'pubsub', maxDeliverDelayMs: null, ordering: 'none' },
  features: { dlq: true, cron: true, flows: false, workflows: false, webhooks: false },
  hidden: ['serverControl', 'sqliteDatabase', 's3Backup', 'fleet', 'queueOperations'],
  unsupported: ['job-fail', 'job-discard', 'job-retry', 'job-move-to-delayed', 'dlq-retry'],
  principal: { role: 'operator' },
  version: '1.0.0',
};

describe('parseCapabilities', () => {
  test('reads the server answer and ignores fields it does not know', () => {
    const parsed = parseCapabilities({ ...CLOUD, somethingNew: { a: 1 } });
    expect(parsed).toEqual(CLOUD);
  });

  test.each([
    ['not an object', 'nope'],
    ['no principal', { ...CLOUD, principal: undefined }],
    ['an unknown role', { ...CLOUD, principal: { role: 'admin' } }],
    ['a feature that is not a boolean', { ...CLOUD, features: { ...CLOUD.features, dlq: 'yes' } }],
  ])('%s is an error, never a guess', (_name, value) => {
    expect(() => parseCapabilities(value)).toThrow(CapabilitiesError);
  });
});

describe('page gating', () => {
  test('the hidden server concepts are closed, including everything beneath them', () => {
    for (const path of ['/server', '/server/logs', '/database', '/s3', '/s3-classic', '/fleet']) {
      expect(isPageAvailable(path, CLOUD)).toBe(false);
    }
  });

  test('features that are off close their pages and their sub-pages', () => {
    for (const path of ['/flows', '/workflows', '/workflows/executions', '/webhooks']) {
      expect(isPageAvailable(path, CLOUD)).toBe(false);
    }
    const flowsOn = { ...CLOUD, features: { ...CLOUD.features, flows: true, workflows: true } };
    expect(isPageAvailable('/flows', flowsOn)).toBe(true);
    expect(isPageAvailable('/workflows/waiting', flowsOn)).toBe(true);
    expect(isPageAvailable('/webhooks', flowsOn)).toBe(false);
  });

  test('the pages a job queue always has are never closed', () => {
    for (const path of [
      '/',
      '/queues',
      '/queues/billing',
      '/jobs',
      '/job',
      '/workers',
      '/diagnostics',
      '/settings',
      '/unknown',
    ]) {
      expect(isPageAvailable(path, CLOUD)).toBe(true);
      expect(isGatedPage(path)).toBe(false);
    }
  });

  test('pages that exist to change things are for operators, and a viewer is turned away', () => {
    const viewer: Capabilities = { ...CLOUD, principal: { role: 'viewer' } };
    for (const path of ['/add-job', '/jobs/bulk-add', '/queue-control', '/benchmark']) {
      expect(isGatedPage(path)).toBe(true);
      expect(isPageAvailable(path, CLOUD)).toBe(true);
      expect(needsOperator(path, CLOUD)).toBe(false);
      expect(isPageAvailable(path, viewer)).toBe(false);
      expect(needsOperator(path, viewer)).toBe(true);
      // Not closed by the deployment: the page that replaces it says why, in its own words.
      expect(closedFeatureName(path, viewer)).toBeNull();
    }
    // The inspector and the job list are read pages: a viewer has them.
    for (const path of ['/job', '/jobs', '/queues', '/dlq', '/cron']) {
      expect(isPageAvailable(path, viewer)).toBe(true);
    }
    // A page the deployment closes stays closed for an operator too, and is not "operator" news.
    expect(needsOperator('/webhooks', viewer)).toBe(false);
    expect(isPageAvailable('/webhooks', CLOUD)).toBe(false);
    expect(needsOperator('/dlq-control', viewer)).toBe(true);
  });

  test('a path that only starts with a closed name is not caught by it', () => {
    expect(isPageAvailable('/servers-list', CLOUD)).toBe(true);
    expect(isPageAvailable('/flowsheet', CLOUD)).toBe(true);
    expect(isPageAvailable('/server/', CLOUD)).toBe(false);
  });

  test('DLQ and cron follow their feature flags', () => {
    const off = { ...CLOUD, features: { ...CLOUD.features, dlq: false, cron: false } };
    expect(isPageAvailable('/dlq', off)).toBe(false);
    expect(isPageAvailable('/dlq-control', off)).toBe(false);
    expect(isPageAvailable('/cron', off)).toBe(false);
    expect(isPageAvailable('/cron-manager', off)).toBe(false);
    expect(isPageAvailable('/dlq', CLOUD)).toBe(true);
  });

  test('before an answer, and after a failure, every closable page is closed', () => {
    for (const path of ['/server', '/dlq', '/cron', '/flows', '/fleet']) {
      expect(isPageAvailable(path, FAIL_CLOSED)).toBe(false);
    }
    expect(mayOperate(FAIL_CLOSED)).toBe(false);
  });

  test('the closed page is named for the page that replaces it', () => {
    expect(closedFeatureName('/server', CLOUD)).toBe('Server control');
    expect(closedFeatureName('/workflows/archive', CLOUD)).toBe('Workflows');
    expect(closedFeatureName('/jobs', CLOUD)).toBeNull();
  });

  test('the demo answer opens everything', () => {
    for (const path of [
      '/server',
      '/database',
      '/s3',
      '/fleet',
      '/flows',
      '/workflows',
      '/webhooks',
    ]) {
      expect(isPageAvailable(path, DEMO_CAPABILITIES)).toBe(true);
    }
  });
});

describe('roles and unsupported actions', () => {
  test('only an operator may operate', () => {
    expect(mayOperate(CLOUD)).toBe(true);
    expect(mayOperate({ ...CLOUD, principal: { role: 'viewer' } })).toBe(false);
  });

  test('an action the server closes is not supported; others are', () => {
    expect(isActionSupported(CLOUD, 'job-retry')).toBe(false);
    expect(isActionSupported(CLOUD, 'dlq-retry')).toBe(false);
    expect(isActionSupported(CLOUD, 'job-promote')).toBe(true);
  });

  test('a concept the deployment lists as hidden is left out; the fail-closed answer hides them all', () => {
    expect(isConceptHidden(CLOUD, 'queueOperations')).toBe(true);
    expect(isConceptHidden(DEMO_CAPABILITIES, 'queueOperations')).toBe(false);
    expect(isConceptHidden(FAIL_CLOSED, 'queueOperations')).toBe(true);
  });
});
