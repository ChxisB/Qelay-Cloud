import { describe, expect, test } from 'bun:test';
import { FlowPage } from '../src/features/flows/ui/FlowPage';
import { button, click } from './control-dom.helpers';
import { flush, installPageHooks, stuckRepo } from './flow-page.helpers';
import {
  fakeRepository,
  mountFlows,
  setScreenWidth,
  syntheticFlow,
  treeRows,
} from './flow.helpers';

installPageHooks();

const GRAPH = '[role="group"][aria-label="Graph of the jobs of the flow"]';

async function openWide(path = '/flows?root=root', repository = stuckRepo(), width = 1024) {
  setScreenWidth(width);
  const page = mountFlows(<FlowPage repository={repository} />, path);
  await flush();
  return { repository, ...page };
}
const boxes = (host: ParentNode) =>
  [
    ...host.querySelectorAll(
      `${GRAPH} [data-flow-state] > button[aria-label]:not([aria-expanded])`
    ),
  ] as HTMLElement[];
const names = (host: ParentNode) => boxes(host).map((box) => box.getAttribute('aria-label'));
/** The Graph and List switch writes `graph` and `list`; the screen capitalises them. */
const choice = (host: ParentNode, text: string) =>
  [...host.querySelectorAll<HTMLButtonElement>('fieldset button')].find(
    (item) => item.textContent === text
  )!;
const pressed = (host: ParentNode, text: string) =>
  choice(host, text).getAttribute('aria-pressed') === 'true';

describe('flow page: the graph', () => {
  test('a wide screen starts on the graph, one box per job, each named with its state', async () => {
    const { host } = await openWide();
    expect(host.querySelector('[role="tree"]')).toBeNull();
    expect(pressed(host, 'graph')).toBe(true);
    expect(names(host)).toEqual([
      'waiting children job root in orders, Waiting on 1',
      'completed job ok in orders',
      'failed job bad in orders, Holds parent, 3 tries',
    ]);
    // The failure is drawn on its line and on its box, and the word is there too.
    expect(host.querySelectorAll(`${GRAPH} svg[width] path.stroke-danger`)).toHaveLength(1);
    // Each line is a curve and an arrowhead.
    expect(host.querySelectorAll(`${GRAPH} svg[width] path`)).toHaveLength(4);
    expect(boxes(host)[2]!.textContent).toContain('Holds parent');
  });

  test('a narrow screen starts on the list', async () => {
    const { host } = await openWide('/flows?root=root', stuckRepo(), 500);
    expect(treeRows(host)).toHaveLength(3);
    expect(pressed(host, 'list')).toBe(true);
    expect(host.querySelector(GRAPH)).toBeNull();
  });

  test('selecting a box puts the job in the address and in the panel, as a line of the list does', async () => {
    const { host, search, repository } = await openWide();
    click(boxes(host)[2]!);
    await flush();
    expect(search()).toBe('?root=root&node=bad');
    expect(boxes(host)[2]!.getAttribute('aria-current')).toBe('true');
    expect(boxes(host)[1]!.getAttribute('aria-current')).toBeNull();
    const panel = host.querySelector('aside[aria-label="Selected job"]')!;
    expect(panel.textContent).toContain('SMTP 550: mailbox unavailable');
    expect(repository.calls.views).toHaveLength(1);
  });

  test('a job named in the address is the selected box when the flow opens', async () => {
    const { host } = await openWide('/flows?root=root&node=ok');
    expect(boxes(host)[1]!.getAttribute('aria-current')).toBe('true');
  });

  test('the switch moves between the graph and the list without reading the flow again', async () => {
    const { host, repository } = await openWide();
    click(choice(host, 'list'));
    expect(treeRows(host).map(([id]) => id)).toEqual(['root', 'ok', 'bad']);
    expect(host.querySelector(GRAPH)).toBeNull();
    click(choice(host, 'graph'));
    expect(boxes(host)).toHaveLength(3);
    expect(repository.calls.views).toHaveLength(1);
  });

  test('the chip on a parent hides and shows the jobs below it, and says how many', async () => {
    const { host } = await openWide();
    const hide = host.querySelector<HTMLButtonElement>(
      'button[aria-label="Hide the 2 jobs below root"]'
    )!;
    expect(hide.getAttribute('aria-expanded')).toBe('true');
    click(hide);
    expect(names(host)).toHaveLength(1);
    const show = host.querySelector<HTMLButtonElement>(
      'button[aria-label="Show the 2 jobs below root"]'
    )!;
    expect(show.getAttribute('aria-expanded')).toBe('false');
    expect(show.textContent).toBe('+2');
    click(show);
    expect(names(host)).toHaveLength(3);
  });

  test('more than 300 open jobs is shown as the list, with a note', async () => {
    const repository = fakeRepository({ view: () => syntheticFlow(400) });
    const { host } = await openWide('/flows?root=n0', repository);
    expect(names(host).length).toBeLessThanOrEqual(300);
    click(button(host, 'Expand all'));
    expect(host.querySelector(GRAPH)).toBeNull();
    expect(host.querySelector('[role="tree"]')).not.toBeNull();
    expect(host.querySelector('[role="status"]')?.textContent).toContain('too many to draw');
    expect(pressed(host, 'graph')).toBe(true);
    click(button(host, 'Collapse all'));
    expect(host.querySelector(GRAPH)).not.toBeNull();
  });
});
