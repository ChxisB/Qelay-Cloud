import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, createElement, Fragment } from 'react';
import { useConfirmStore } from '../src/components/dashboard/stores/confirmStore';
import { useConnectionStore } from '../src/components/dashboard/stores/connectionStore';
import { useGlobalModalStore } from '../src/components/dashboard/stores/globalModalStore';
import { ConfirmDialog } from '../src/components/ui/ConfirmDialog';
import { ConnectionProfilesCard } from '../src/pages/settings/ConnectionProfilesCard';
import { click, renderUi } from './control-dom.helpers';
import { ensureDom, settle } from './domSetup';

// Remove asks in the page's own dialog (the real ConfirmDialog is mounted here) and drops the profile only on a yes.

const SHOWN = '[role="alertdialog"]';
const profile = (id: string, name: string) => ({
  id,
  name,
  baseUrl: `https://${id}.example/api`,
  agentBaseUrl: `https://${id}.example/agent`,
});

let view: { host: HTMLElement; unmount: () => void };

beforeEach(() => {
  ensureDom();
  useConfirmStore.setState({ current: null, queue: [] });
  useGlobalModalStore.getState().reset();
  useConnectionStore.setState({
    profiles: [profile('a', 'Broker A'), profile('b', 'Broker B')],
    activeProfileId: 'a',
    baseUrl: 'https://a.example/api',
    agentBaseUrl: 'https://a.example/agent',
    token: '',
    agentToken: '',
  });
  view = renderUi(
    createElement(
      Fragment,
      null,
      createElement(ConnectionProfilesCard),
      createElement(ConfirmDialog)
    )
  );
});

afterEach(() => {
  view.unmount();
  useConfirmStore.setState({ current: null, queue: [] });
  useConnectionStore.setState({
    profiles: [
      {
        id: 'default',
        name: 'Local Qelay',
        baseUrl: '/api',
        agentBaseUrl: 'http://localhost:6800',
      },
    ],
    activeProfileId: 'default',
    baseUrl: '/api',
    agentBaseUrl: 'http://localhost:6800',
  });
});

const dialog = () => view.host.querySelector<HTMLElement>(SHOWN);
const named = (scope: ParentNode, text: string) =>
  [...scope.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
const names = () => useConnectionStore.getState().profiles.map((p) => p.name);

describe('Remove connection', () => {
  test('asks first, names the profile, and Cancel and Escape keep it', async () => {
    click(named(view.host, 'Remove')!);
    await settle(10);
    expect(dialog()?.textContent).toContain('Remove this connection?');
    expect(dialog()?.textContent).toContain('Broker A');
    expect(names()).toEqual(['Broker A', 'Broker B']);

    click(named(dialog()!, 'Cancel')!);
    await settle(260);
    expect(names()).toEqual(['Broker A', 'Broker B']);

    click(named(view.host, 'Remove')!);
    await settle(10);
    act(() =>
      document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    );
    await settle(260);
    expect(dialog()).toBeNull();
    expect(names()).toEqual(['Broker A', 'Broker B']);
  });

  test('a second click asks once, and a yes removes the profile', async () => {
    const remove = named(view.host, 'Remove')!;
    click(remove);
    click(remove);
    await settle(10);
    expect(view.host.querySelectorAll(SHOWN)).toHaveLength(1);

    click(named(dialog()!, 'Remove')!);
    await settle(260);
    expect(names()).toEqual(['Broker B']);
  });
});
