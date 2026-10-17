import { describe, expect, test } from 'bun:test';
import { ControlApiConfigError, runtimeSettingsFromEnv } from '../src';
import { resolveJobsConfig } from '../src/jobs/limits';

const BASE = {
  QCLOUD_DATABASE_URL: 'postgres://qcloud:hunter2-db-password@db.internal:5432/qcloud',
  QCLOUD_API_OIDC_ISSUER: 'https://accounts.example.com/',
  QCLOUD_API_OIDC_AUDIENCE: 'qelay-control-api',
  QCLOUD_API_OIDC_JWKS_URL: 'https://accounts.example.com/jwks.json',
};

describe('the workflow settings of the Control API process', () => {
  test('default to the engine queue, the tick idle window and a page that follows the schema', () => {
    const settings = runtimeSettingsFromEnv(BASE);
    expect(settings.jobs).toEqual({});
    expect(settings.features).toEqual({});
    const config = resolveJobsConfig(settings.jobs);
    expect(config).toMatchObject({
      workflowQueue: '__wf:steps',
      workflowIdleMs: 300_000,
      workflowServedMs: 120_000,
    });
  });

  test('take the queue and the idle window from the names the maintenance tick reads', () => {
    const settings = runtimeSettingsFromEnv({
      ...BASE,
      QCLOUD_WORKFLOW_QUEUE: 'orders-engine',
      QCLOUD_WORKFLOW_IDLE_MS: '60000',
      QCLOUD_API_WORKFLOW_SERVED_MS: '30000',
    });
    expect(settings.jobs).toEqual({
      workflowQueue: 'orders-engine',
      workflowIdleMs: 60_000,
      workflowServedMs: 30_000,
    });
    expect(resolveJobsConfig(settings.jobs)).toMatchObject({
      workflowQueue: 'orders-engine',
      workflowIdleMs: 60_000,
      workflowServedMs: 30_000,
    });
  });

  test('QCLOUD_API_WORKFLOWS=false hides the page; true and unset leave it to the schema', () => {
    expect(runtimeSettingsFromEnv({ ...BASE, QCLOUD_API_WORKFLOWS: 'false' }).features).toEqual({
      workflows: false,
    });
    for (const value of ['true', undefined]) {
      const env = value === undefined ? BASE : { ...BASE, QCLOUD_API_WORKFLOWS: value };
      expect(runtimeSettingsFromEnv(env).features).toEqual({});
    }
    expect(() => runtimeSettingsFromEnv({ ...BASE, QCLOUD_API_WORKFLOWS: 'maybe' })).toThrow(
      ControlApiConfigError
    );
  });

  test('refuse a window or queue that cannot work, naming the option and not a value', () => {
    for (const bad of [{ workflowIdleMs: 0 }, { workflowServedMs: -1 }, { workflowQueue: '' }]) {
      expect(() => resolveJobsConfig(bad)).toThrow(ControlApiConfigError);
    }
    expect(() => runtimeSettingsFromEnv({ ...BASE, QCLOUD_WORKFLOW_IDLE_MS: 'soon' })).toThrow(
      /QCLOUD_WORKFLOW_IDLE_MS/
    );
  });
});
