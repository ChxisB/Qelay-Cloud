import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createElement, Fragment } from 'react';
import { useConfirmStore } from '../src/components/dashboard/stores/confirmStore';
import { useGlobalModalStore } from '../src/components/dashboard/stores/globalModalStore';
import { ConfirmDialog } from '../src/components/ui/ConfirmDialog';
import type { BackupRepository } from '../src/features/backups/application/BackupRepository';
import { BackupOperationsPanel } from '../src/features/backups/ui/BackupOperationsPanel';
import { changeControl, click, renderUi } from './control-dom.helpers';
import { ensureDom, settle } from './domSetup';

// Restore replaces the database, so its question is the typed-word kind: the main button stays off until the
// word is typed exactly, and the restore still checks the managed server is stopped after the answer.

const SHOWN = '[role="alertdialog"]';
const database = {
  path: 'data/qelay.db',
  exists: true,
  size: 100,
  walSize: 20,
  shmSize: 10,
  totalSize: 130,
  mtimeMs: 1234,
};

let server: 'stopped' | 'running';
let restores: string[];
let views: Array<{ unmount: () => void }>;

beforeEach(() => {
  ensureDom();
  useConfirmStore.setState({ current: null, queue: [] });
  useGlobalModalStore.getState().reset();
  server = 'stopped';
  restores = [];
  views = [];
});

afterEach(() => {
  for (const view of views) view.unmount();
  useConfirmStore.setState({ current: null, queue: [] });
});

const repository: BackupRepository = {
  status: async () => ({
    success: true,
    message: 'configured',
    data: {
      enabled: true,
      bucket: 'production',
      endpoint: 'AWS S3',
      interval: '6 h',
      retention: '7',
    },
  }),
  list: async () => ({
    success: true,
    message: 'one backup',
    data: [{ key: 'backups/one.db', size: '1.00 MB', date: '2026-08-04T10:00:00.000Z' }],
  }),
  backupNow: async () => ({ success: true, message: 'ok' }),
  restore: async (key) => {
    restores.push(key);
    return { success: true, message: 'Restore complete' };
  },
  configure: async () => ({ configured: true, enabled: true }),
  restoreContext: async () => ({ serverStatus: server, database }),
};

function mount() {
  const view = renderUi(
    createElement(
      Fragment,
      null,
      createElement(BackupOperationsPanel, { repository, pollIntervalMs: 20 }),
      createElement(ConfirmDialog)
    )
  );
  views.push(view);
  return view.host;
}

const dialog = (host: HTMLElement) => host.querySelector<HTMLElement>(SHOWN);
const main = (host: HTMLElement) =>
  [...(dialog(host)?.querySelectorAll('button') ?? [])].find((b) => b.textContent === 'Restore');

describe('Restore asks for the typed word', () => {
  test('sends nothing until RESTORE is typed exactly, then restores once', async () => {
    const host = mount();
    await settle(40);
    click([...host.querySelectorAll('button')].find((b) => b.textContent?.includes('Restore'))!);
    await settle(10);

    expect(dialog(host)?.textContent).toContain('Restore this backup?');
    expect(dialog(host)?.textContent).toContain('Type RESTORE to replace data/qelay.db');
    const typed = dialog(host)?.querySelector('input');
    if (!typed) throw new Error('The typed-word field is missing');
    expect(main(host)?.disabled).toBe(true);

    changeControl(typed, 'restore');
    expect(main(host)?.disabled).toBe(true);
    changeControl(typed, 'RESTORE');
    expect(main(host)?.disabled).toBe(false);
    expect(restores).toEqual([]);

    click(main(host)!);
    await settle(40);
    expect(restores).toEqual(['backups/one.db']);
  });

  test('restores nothing when the server starts while the question is open', async () => {
    const host = mount();
    await settle(40);
    click([...host.querySelectorAll('button')].find((b) => b.textContent?.includes('Restore'))!);
    await settle(10);
    const typed = dialog(host)?.querySelector('input');
    if (!typed) throw new Error('The typed-word field is missing');
    changeControl(typed, 'RESTORE');

    server = 'running';
    await settle(80);
    click(main(host)!);
    await settle(40);
    expect(restores).toEqual([]);
  });
});
