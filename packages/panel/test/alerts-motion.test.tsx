import { type AlertRule, useAlertsStore } from '../src/components/dashboard/stores/alertsStore';
import type { Breach } from '../src/lib/alertEngineMetrics';
import { alertConnectionIdentity, useAlertRuntimeStore } from '../src/lib/useAlertEngine';
import { Alerts } from '../src/pages/Alerts';
import { answerConfirms } from './confirmSupport';
import {
  act,
  afterEach,
  beforeEach,
  createElement,
  createRoot,
  describe,
  expect,
  installTestHooks,
  MemoryRouter,
  type ReactElement,
  settle,
  test,
} from './server-action-pages.helpers';

// Monitor: Workers and Alerts. Both removals ask in the page and send the same call as before; a row that goes
// stays 180ms and leaves; a poll that changes nothing animates nothing. happy-dom plays no animation, so these
// check classes, element identity and when an element goes away.

installTestHooks();

function mount(element: ReactElement) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const show = (next: ReactElement) =>
    act(() => root.render(createElement(MemoryRouter, null, next)));
  show(element);
  return {
    host,
    show,
    unmount: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

const click = (el: Element | null | undefined) => act(() => (el as HTMLElement).click());
const rowOf = (host: ParentNode, text: string) =>
  [...host.querySelectorAll<HTMLElement>('tbody tr')].find((tr) => tr.textContent?.includes(text));
const leaves = async () => {
  await settle(60);
  await settle(260);
};

describe('alert rules', () => {
  const rule = (id: string, name: string, enabled = true): AlertRule => ({
    id,
    name,
    metric: 'waiting',
    operator: '>=',
    threshold: 10,
    queue: '',
    channel: 'email',
    enabled,
  });
  const breach = (id: string, name: string): Breach => ({
    ruleId: id,
    ruleName: name,
    metricLabel: 'Waiting jobs',
    operator: '>=',
    threshold: 10,
    value: 12,
    queue: '',
    at: Date.now(),
  });
  const runtime = (breaching: Breach[]) =>
    useAlertRuntimeStore.setState({
      breaching,
      status: 'live',
      error: null,
      connectionIdentity: alertConnectionIdentity('http://server-a.test', ''),
    });
  beforeEach(() => runtime([]));
  afterEach(() => {
    useAlertsStore.setState({ rules: [] });
    runtime([]);
  });
  const sections = (host: ParentNode) => [...host.querySelectorAll('section')];

  test('the switch says Enabled or Disabled and is named for its rule; flipping it says so in words', () => {
    useAlertsStore.setState({ rules: [rule('r1', 'Backlog')] });
    const view = mount(createElement(Alerts));
    const switchOf = () => view.host.querySelector<HTMLElement>('button[role="switch"]');
    expect(switchOf()?.getAttribute('aria-label')).toBe('Disable rule Backlog');
    expect(switchOf()?.parentElement?.textContent).toContain('Enabled');

    click(switchOf());
    expect(useAlertsStore.getState().rules[0]?.enabled).toBe(false);
    expect(switchOf()?.getAttribute('aria-label')).toBe('Enable rule Backlog');
    expect(switchOf()?.parentElement?.textContent).toBe('Disabled');
    expect(view.host.querySelector('p[role="status"]')?.textContent).toBe(
      'Rule "Backlog" is disabled.'
    );
    view.unmount();
  });

  test('delete asks in the page; no keeps the rule, yes removes it, the row leaves and the sentence is said', async () => {
    useAlertsStore.setState({ rules: [rule('r1', 'Backlog'), rule('r2', 'Errors')] });
    const view = mount(createElement(Alerts));
    const del = () => view.host.querySelector('button[aria-label="Delete rule Backlog"]');

    const no = answerConfirms(false);
    click(del());
    await settle(20);
    no.stop();
    expect(no.questions).toEqual([
      { question: 'Delete alert rule "Backlog"?', confirmLabel: 'Delete rule', danger: true },
    ]);
    expect(useAlertsStore.getState().rules).toHaveLength(2);

    const yes = answerConfirms(true);
    click(del());
    await settle(20);
    yes.stop();
    expect(useAlertsStore.getState().rules.map((r) => r.id)).toEqual(['r2']);
    const leaving = rowOf(view.host, 'Backlog');
    expect(leaving?.classList.contains('motion-leave')).toBe(true);
    expect(leaving?.hasAttribute('inert')).toBe(true);
    expect(view.host.querySelector('p[role="status"]')?.textContent).toBe(
      'Deleted rule "Backlog".'
    );

    await leaves();
    expect(rowOf(view.host, 'Backlog')).toBeUndefined();
    expect(rowOf(view.host, 'Errors')).toBeDefined();
    view.unmount();
  });

  test('a rule that fires rises into Triggered alerts; the same result again changes nothing; the last one leaving gives way to the all-clear', async () => {
    useAlertsStore.setState({ rules: [rule('r1', 'Backlog')] });
    runtime([breach('r1', 'Backlog')]);
    const view = mount(createElement(Alerts));
    const fired = () => rowOf(sections(view.host)[0]!, 'Backlog');
    expect(fired()?.classList.contains('motion-arrive')).toBe(true);
    expect(fired()?.textContent).toContain('Firing');
    const first = fired();

    act(() => runtime([breach('r1', 'Backlog')]));
    expect(fired()).toBe(first);
    expect(fired()?.classList.contains('motion-leave')).toBe(false);

    act(() => runtime([]));
    expect(fired()?.classList.contains('motion-leave')).toBe(true);
    expect(fired()?.hasAttribute('inert')).toBe(true);
    expect(sections(view.host)[0]?.textContent).not.toContain('No triggered alerts');
    await leaves();
    expect(fired()).toBeUndefined();
    expect(sections(view.host)[0]?.textContent).toContain('No triggered alerts');
    view.unmount();
  });

  test('the banner says Qelay and names no hosted product', () => {
    const view = mount(createElement(Alerts));
    const banner = view.host.querySelector('[role="status"]')?.textContent ?? '';
    expect(banner).toContain('Qelay has no alerting backend');
    expect(banner).not.toContain('OSS');
    expect(banner).not.toContain('qelay Cloud');
    view.unmount();
  });
});
