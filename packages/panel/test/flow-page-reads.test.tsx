import { describe, expect, test } from 'bun:test';
import { act } from 'react';
import { FlowPage } from '../src/features/flows/ui/FlowPage';
import { BqError } from '../src/lib/bq';
import { button, click, deferred } from './control-dom.helpers';
import { installPageHooks, flush, openStuck } from './flow-page.helpers';
import {
  connectTo,
  fakeRepository,
  flowView,
  mountFlows,
  node,
  serveRole,
  stuckFlow,
  treeRow,
  treeRows,
} from './flow.helpers';

installPageHooks();

describe('flow page: a flow too large to show whole', () => {
  const cut = (limit: number, total: number) =>
    flowView([node('r', { state: 'waiting-children' }), node('c', { parentId: 'r', depth: 1 })], {
      truncated: true,
      total,
      limit,
    });

  test('says how many jobs are shown, offers more, and refuses to remove a flow it only half shows', async () => {
    const repository = fakeRepository({
      view: (_root, limit) =>
        limit < 1_500
          ? cut(limit, 1_500)
          : flowView([node('r'), node('c', { parentId: 'r' })], { total: 1_500, limit }),
    });
    const { host } = mountFlows(<FlowPage repository={repository} />, '/flows?root=r');
    await flush();
    const notice = host.querySelector('[role="status"]')!;
    expect(notice.textContent).toMatch(/Showing 2 of 1[,.]?500 jobs/);
    expect(notice.textContent).toContain('may be out of sight');
    expect(button(host, 'Remove flow…').disabled).toBe(true);
    expect(host.textContent).toContain('Show the whole flow to remove it.');

    click(button(host, 'Show more'));
    await flush();
    expect(repository.calls.views.map((v) => v.limit)).toEqual([1_000, 1_500]);
    expect(host.querySelector('[role="status"]')).toBeNull();
    expect(button(host, 'Remove flow…').disabled).toBe(false);
  });

  test('at the most a view can list, it says so and offers no more', async () => {
    const repository = fakeRepository({ view: (_root, limit) => cut(limit, 6_000) });
    const { host } = mountFlows(<FlowPage repository={repository} />, '/flows?root=r');
    await flush();
    click(button(host, 'Show more'));
    await flush();
    expect(repository.calls.views.at(-1)?.limit).toBe(5_000);
    expect(host.querySelector('[role="status"]')?.textContent).toMatch(
      /limited to 5[.,\u00a0\u202f]?000 jobs/
    );
    expect(() => button(host, 'Show more')).toThrow();
  });
});

describe('flow page: a viewer', () => {
  test('sees the flow, is told why there are no buttons, and is offered none', async () => {
    serveRole('viewer');
    const { host } = await openStuck();
    click(treeRow(host, 'bad'));
    await flush();
    expect(treeRows(host)).toHaveLength(3);
    expect(host.textContent).toContain('SMTP 550: mailbox unavailable');
    expect(host.textContent).toContain('Your role can look at flows but not change them.');
    const labels = [...host.querySelectorAll('button')].map((b) => b.textContent ?? '');
    for (const forbidden of ['Retry', 'Release', 'Remove']) {
      expect(labels.filter((label) => label.includes(forbidden))).toEqual([]);
    }
  });
});

describe('flow page: finding a flow from a job', () => {
  test('a job inside a flow opens that flow with the job selected', async () => {
    const repository = fakeRepository({
      view: (root) => {
        if (root === 'bad') throw new BqError('no such flow', 404, 'flow_not_found');
        return stuckFlow();
      },
      rootOf: () => 'root',
    });
    const { host, search } = mountFlows(<FlowPage repository={repository} />, '/flows?root=bad');
    await flush();
    expect(repository.calls.rootOfs).toEqual(['bad']);
    expect(search()).toBe('?root=root&node=bad');
    expect(treeRow(host, 'bad').getAttribute('aria-selected')).toBe('true');
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  test('a job that is in no flow says so', async () => {
    const repository = fakeRepository({
      view: () => {
        throw new BqError('no such flow', 404, 'flow_not_found');
      },
      rootOf: () => null,
    });
    const { host } = mountFlows(<FlowPage repository={repository} />, '/flows?root=lonely');
    await flush();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      'Job lonely is not part of a flow.'
    );
  });

  test('when the job cannot be looked up either, the first error is shown', async () => {
    const repository = fakeRepository({
      view: () => {
        throw new BqError('no such flow', 404, 'flow_not_found');
      },
      rootOf: () => {
        throw new Error('lookup failed');
      },
    });
    const { host } = mountFlows(<FlowPage repository={repository} />, '/flows?root=odd');
    await flush();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('no such flow');
  });

  test('a flow that cannot be reached is shown as offline with a retry', async () => {
    let up = false;
    const repository = fakeRepository({
      view: () => {
        if (!up) throw new BqError('connection refused', 0);
        return stuckFlow();
      },
    });
    const { host } = mountFlows(<FlowPage repository={repository} />, '/flows?root=root');
    await flush();
    expect(host.textContent).toContain('Could not load flows — connection refused');
    up = true;
    click(button(host, 'Retry'));
    await flush();
    expect(treeRows(host)).toHaveLength(3);
  });
});

describe('flow page: another connection', () => {
  test('a reply that arrives after the connection changed is not drawn against the new one', async () => {
    const slow = deferred<ReturnType<typeof stuckFlow>>();
    let requests = 0;
    const repository = fakeRepository({
      view: () => {
        requests += 1;
        if (requests === 1) return slow.promise;
        return flowView([
          node('root', { state: 'waiting-children' }),
          node('b-only', { parentId: 'root', depth: 1 }),
        ]);
      },
    });
    const { host } = mountFlows(<FlowPage repository={repository} />, '/flows?root=root');
    await flush();
    act(() => connectTo('http://server-b.test'));
    await flush();
    expect(treeRows(host).map(([id]) => id)).toEqual(['root', 'b-only']);
    // Server A answers late: its jobs are not mixed into server B's flow.
    slow.resolve(stuckFlow());
    await flush();
    expect(treeRows(host).map(([id]) => id)).toEqual(['root', 'b-only']);
    expect(repository.calls.views).toHaveLength(2);
  });
});
