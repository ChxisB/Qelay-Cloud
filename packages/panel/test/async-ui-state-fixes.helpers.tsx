import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, createElement, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { useAlertsStore } from '../src/components/dashboard/stores/alertsStore';
import { useConnectionStore } from '../src/components/dashboard/stores/connectionStore';
import { ConnectionBadge } from '../src/components/layout/ConnectionBadge';
import { useActivityStream } from '../src/lib/useActivityStream';
import { alertConnectionIdentity, useAlertRuntimeStore } from '../src/lib/useAlertEngine';
import { Alerts } from '../src/pages/Alerts';
import { CronManager } from '../src/pages/control/CronManager';
import { DlqPro } from '../src/pages/control/DlqPro';
import { JobsPro } from '../src/pages/control/JobsPro';
import { OverviewPro } from '../src/pages/control/OverviewPro';
import { S3BackupPro } from '../src/pages/control/S3BackupPro';
import { ProcessLogs } from '../src/pages/control/server/ProcessLogs';
import { UsagePro } from '../src/pages/control/UsagePro';
import { ensureDom, renderHook, settle } from './domSetup';

const realFetch = globalThis.fetch;

function render(element: ReactElement) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(element));
  return {
    host,
    unmount: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

export type { ReactElement };
export {
  Alerts,
  act,
  afterEach,
  alertConnectionIdentity,
  beforeEach,
  ConnectionBadge,
  CronManager,
  createElement,
  createRoot,
  DlqPro,
  describe,
  ensureDom,
  expect,
  JobsPro,
  MemoryRouter,
  OverviewPro,
  ProcessLogs,
  realFetch,
  render,
  renderHook,
  S3BackupPro,
  settle,
  test,
  UsagePro,
  useActivityStream,
  useAlertRuntimeStore,
  useAlertsStore,
  useConnectionStore,
};

export function installTestHooks() {
  beforeEach(() => {
    ensureDom();
    useConnectionStore.setState({
      baseUrl: 'http://server.test',
      token: '',
      agentToken: '',
      refreshMs: 3000,
    });
    useAlertsStore.setState({ rules: [] });
    useAlertRuntimeStore.setState({
      breaching: [],
      status: 'idle',
      error: null,
      connectionIdentity: null,
    });
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    useConnectionStore.setState({ baseUrl: '/api', token: '', agentToken: '', refreshMs: 3000 });
    useAlertsStore.setState({ rules: [] });
  });
}
