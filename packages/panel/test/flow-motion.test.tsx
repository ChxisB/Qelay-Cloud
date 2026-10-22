import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, createElement, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { buildFlowTree, flowRows } from '../src/features/flows/domain/flowTree';
import type { FlowNode } from '../src/features/flows/domain/flowWire';
import { FlowGraph } from '../src/features/flows/ui/FlowGraph';
import { FlowList } from '../src/features/flows/ui/FlowList';
import type { WorkflowDetail } from '../src/features/workflows/domain/workflowWire';
import { DefinitionGraph } from '../src/features/workflows/ui/DefinitionGraph';
import { ExecutionList } from '../src/features/workflows/ui/ExecutionList';
import { StepTimeline } from '../src/features/workflows/ui/StepTimeline';
import { ensureDom, settle } from './domSetup';
import { flowList, node } from './flow.helpers';
import { demoRepository, installWorkflowHooks } from './workflow.helpers';

// The flow graph, the workflow chain and timeline, and the two lists: what arrives on the first load and what a
// poll that changes one thing animates. happy-dom plays no animation, so these check which elements carry the
// motion classes and whether an element is the same one after the poll.

installWorkflowHooks();

const mounted: Array<() => void> = [];
function mount(element: ReactElement) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const show = (next: ReactElement) =>
    act(() => root.render(createElement(MemoryRouter, null, next)));
  show(element);
  mounted.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  return { host, show };
}
beforeEach(ensureDom);
afterEach(() => {
  for (const unmount of mounted.splice(0)) unmount();
});

const pending = (id: string, overrides: Partial<FlowNode> = {}) =>
  node(id, { parentId: 'root', depth: 1, ...overrides });
function graph(nodes: FlowNode[], selectedId: string | null = null, open?: string[]) {
  const tree = buildFlowTree(nodes);
  const rows = flowRows(tree, new Set(open ?? nodes.map((n) => n.id)));
  return createElement(FlowGraph, {
    rows,
    tree,
    selectedId,
    onSelect: () => {},
    onToggle: () => {},
  });
}
const FLOW = () => [
  node('root', { state: 'waiting-children', attempts: 0 }),
  pending('a', { state: 'active' }),
  pending('b', { state: 'waiting' }),
  pending('c', { parentId: 'a', depth: 2 }),
];
const boxes = (host: ParentNode) => [...host.querySelectorAll<HTMLElement>('[data-flow-state]')];
const lines = (host: ParentNode) => [...host.querySelectorAll<SVGGElement>('svg > g')];
const placeOf = (el: Element) => (el as HTMLElement).style.getPropertyValue('--i');

describe('flow graph', () => {
  test('the jobs and lines of the first load arrive in graph order; one a re-render adds does not', () => {
    const { host, show } = mount(graph(FLOW(), null, ['root']));
    expect(boxes(host).map((box) => [box.getAttribute('data-flow-state'), placeOf(box)])).toEqual([
      ['waiting-children', '0'],
      ['active', '1'],
      ['waiting', '1'],
    ]);
    expect(boxes(host).every((box) => box.classList.contains('motion-arrive'))).toBe(true);
    expect(lines(host).map(placeOf)).toEqual(['1', '1']);

    show(graph(FLOW(), null, ['root', 'a']));
    expect(boxes(host)).toHaveLength(4);
    const late = boxes(host).find((box) => box.querySelector('[aria-label*="job c"]'));
    expect(late?.classList.contains('motion-arrive')).toBe(false);
    expect(lines(host).filter((line) => line.classList.contains('motion-draw'))).toHaveLength(2);
  });

  test('a poll that changes nothing replaces nothing and washes nothing', () => {
    const { host, show } = mount(graph(FLOW()));
    const before = [...boxes(host), ...lines(host)];
    show(graph(FLOW()));
    expect([...boxes(host), ...lines(host)]).toEqual(before);
    expect(host.querySelectorAll('.motion-flash')).toHaveLength(0);
  });

  test('a job whose state changes washes its word once and draws the line into it again', () => {
    const { host, show } = mount(graph(FLOW()));
    const before = lines(host);
    const next = FLOW();
    next[1] = pending('a', { state: 'completed' });
    show(graph(next));

    const washed = [...host.querySelectorAll('.motion-flash')];
    expect(washed).toHaveLength(1);
    expect(washed[0]?.textContent).toBe('completed');
    const after = lines(host);
    expect(after[0]).not.toBe(before[0]);
    expect(after[0]?.classList.contains('motion-draw')).toBe(true);
    expect(placeOf(after[0]!)).toBe('');
    expect(after[1]).toBe(before[1]);
    expect(after.filter((line) => line.classList.contains('motion-draw'))).toHaveLength(
      after.length
    );

    // The same data again: the wash stays where it is and nothing else restarts.
    const settled = lines(host);
    show(graph(next));
    expect(lines(host)).toEqual(settled);
    expect(host.querySelectorAll('.motion-flash')).toHaveLength(1);
  });

  test('every job says its state in a word and a glyph', () => {
    const { host } = mount(graph(FLOW()));
    for (const box of boxes(host)) {
      expect(box.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
      expect(box.textContent?.trim().length).toBeGreaterThan(0);
    }
    expect(boxes(host).map((box) => box.querySelector('.capitalize')?.textContent)).toEqual([
      'waiting children',
      'active',
      'completed',
      'waiting',
    ]);
  });
});

describe('flow list', () => {
  test('the first load rises in order, a changed Jobs count washes, a row added later does not rise', () => {
    const base = flowList().flows[0]!;
    const rows = (...totals: number[]) =>
      flowList({
        flows: totals.map((total, i) => ({ ...base, id: `root-${i}`, total })),
        total: totals.length,
      });
    const props = (list: ReturnType<typeof rows>) =>
      createElement(FlowList, { list, page: 0, onPage: () => {}, onOpen: () => {} });
    const { host, show } = mount(props(rows(3, 4)));
    const arrived = () =>
      [...host.querySelectorAll<HTMLElement>('tbody tr.motion-arrive')].map(placeOf);
    expect(arrived()).toEqual(['0', '1']);
    expect(host.querySelectorAll('.motion-flash')).toHaveLength(0);

    show(props(rows(3, 5)));
    expect(host.querySelectorAll('.motion-flash')).toHaveLength(1);
    expect(host.querySelector('.motion-flash')?.textContent).toBe('5');

    show(props(rows(3, 5, 6)));
    expect(host.querySelectorAll('tbody tr')).toHaveLength(3);
    expect(arrived()).toEqual(['0', '1']);
  });
});

describe('workflow runs', () => {
  const ID = 'wf-order-2026-0804';
  async function detail() {
    return demoRepository().detail(ID, 25);
  }
  const chain = (host: ParentNode) => [
    ...host.querySelectorAll<HTMLElement>('ol[aria-label="Nodes of the workflow"] > li'),
  ];
  const graphOf = (run: WorkflowDetail, at = run.execution.currentNodeIndex) =>
    createElement(DefinitionGraph, {
      definition: run.definition,
      currentNodeIndex: at,
      state: run.execution.state,
      steps: run.steps,
    });

  test('the chain arrives node by node with its lines; moving the run on marks only the node it left', async () => {
    const run = await detail();
    const { host, show } = mount(graphOf(run));
    const cells = chain(host);
    expect(cells.every((cell) => cell.classList.contains('motion-arrive'))).toBe(true);
    expect(cells.map(placeOf)).toEqual(cells.map((_, i) => String(i)));
    const wires = () => cells.map((cell) => cell.querySelector('svg > g'));
    expect(
      wires()
        .filter(Boolean)
        .every((g) => g?.classList.contains('motion-draw'))
    ).toBe(true);
    expect(host.querySelectorAll('.motion-flash')).toHaveLength(0);

    const before = wires();
    show(graphOf(run));
    expect(wires()).toEqual(before);
    expect(host.querySelectorAll('.motion-flash')).toHaveLength(0);

    show(graphOf(run, run.execution.currentNodeIndex + 1));
    const washed = [...host.querySelectorAll('.motion-flash')].map((el) => el.textContent);
    expect(washed.sort()).toEqual(['Done', 'The run is here']);
    expect(wires().filter((g, i) => g !== before[i])).toHaveLength(2);
  });

  test('the steps of the first load rise with their lines; a step in a later render does not', async () => {
    const run = await detail();
    const timeline = (steps: WorkflowDetail['steps']) =>
      createElement(StepTimeline, {
        repository: demoRepository(),
        executionId: ID,
        first: steps,
      });
    const { host, show } = mount(timeline({ ...run.steps, items: run.steps.items.slice(0, 2) }));
    const items = () => [...host.querySelectorAll<HTMLElement>('ol > li')];
    expect(items().map((li) => [li.classList.contains('motion-arrive'), placeOf(li)])).toEqual([
      [true, '0'],
      [true, '1'],
    ]);
    expect(items()[0]?.querySelector('.motion-draw-y')).not.toBeNull();
    expect(items()[1]?.querySelector('.motion-draw-y')).toBeNull();

    show(timeline({ ...run.steps, items: run.steps.items.slice(0, 3) }));
    expect(items()).toHaveLength(3);
    expect(items()[2]?.classList.contains('motion-arrive')).toBe(false);
    expect(items()[2]?.querySelector('.motion-draw-y')).toBeNull();
  });

  test('the executions rise in order on the first load, and a changed node number washes', async () => {
    const list = await demoRepository().list({ limit: 25, offset: 0 });
    const table = (next: typeof list) =>
      createElement(ExecutionList, {
        list: next,
        filtered: false,
        onPage: () => {},
        onOpen: () => {},
      });
    const { host, show } = mount(table(list));
    const arrived = () =>
      [...host.querySelectorAll<HTMLElement>('tbody tr.motion-arrive')].map(placeOf);
    expect(arrived()).toEqual(list.executions.map((_, i) => String(i)));
    expect(host.querySelectorAll('.motion-flash')).toHaveLength(0);

    show(table(list));
    expect(host.querySelectorAll('.motion-flash')).toHaveLength(0);

    const moved = {
      ...list,
      executions: list.executions.map((run, i) =>
        i === 0 ? { ...run, currentNodeIndex: run.currentNodeIndex + 1 } : run
      ),
    };
    show(table(moved));
    expect(host.querySelectorAll('.motion-flash')).toHaveLength(1);
    expect(arrived()).toEqual(list.executions.map((_, i) => String(i)));
    await settle(1);
  });
});
