import { afterEach, describe, expect, test } from 'bun:test';
import { act, useMemo, useState } from 'react';
import {
  allParents,
  buildFlowTree,
  defaultExpanded,
  flowRows,
} from '../src/features/flows/domain/flowTree';
import type { FlowView } from '../src/features/flows/domain/flowWire';
import { FlowTree } from '../src/features/flows/ui/FlowTree';
import { click, renderUi } from './control-dom.helpers';
import { flowView, node, stuckFlow, syntheticFlow, treeRow, treeRows } from './flow.helpers';
import './domSetup';

interface HarnessProps {
  view: FlowView;
  open?: 'default' | 'all';
  selected?: string | null;
}

/** The tree with the state the explorer keeps for it: what is open and what is selected. */
function Harness({ view, open = 'default', selected = null }: HarnessProps) {
  const tree = useMemo(() => buildFlowTree(view.nodes), [view]);
  const [opened, setOpened] = useState(() =>
    open === 'all' ? allParents(tree) : defaultExpanded(tree)
  );
  const [current, setCurrent] = useState<string | null>(selected);
  const rows = useMemo(() => flowRows(tree, opened), [tree, opened]);
  return (
    <FlowTree
      rows={rows}
      selectedId={current}
      onSelect={setCurrent}
      onToggle={(id) =>
        setOpened((previous) => {
          const next = new Set(previous);
          if (!next.delete(id)) next.add(id);
          return next;
        })
      }
    />
  );
}

const mounted: Array<() => void> = [];
function show(props: HarnessProps) {
  const ui = renderUi(<Harness {...props} />);
  mounted.push(ui.unmount);
  const tree = ui.host.querySelector<HTMLElement>('[role="tree"]')!;
  return { ...ui, tree };
}
afterEach(() => {
  for (const unmount of mounted.splice(0)) unmount();
});

function press(target: HTMLElement, key: string): void {
  const view = target.ownerDocument.defaultView!;
  act(() => {
    target.dispatchEvent(
      new view.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
    );
  });
}

const selectedId = (host: HTMLElement): string | null => {
  const row = host.querySelector('[role="treeitem"][aria-selected="true"]');
  return row ? decodeURIComponent(row.id.replace('flow-row-', '')) : null;
};

describe('flow tree', () => {
  test('draws a line per job with its state, level and place among its siblings', () => {
    const { host } = show({ view: stuckFlow() });
    expect(treeRows(host)).toEqual([
      ['root', 'waiting-children'],
      ['ok', 'completed'],
      ['bad', 'failed'],
    ]);
    const root = treeRow(host, 'root');
    expect(root.getAttribute('aria-level')).toBe('1');
    expect(root.getAttribute('aria-expanded')).toBe('true');
    expect(root.getAttribute('aria-setsize')).toBe('1');
    const bad = treeRow(host, 'bad');
    expect(bad.getAttribute('aria-level')).toBe('2');
    expect(bad.getAttribute('aria-posinset')).toBe('2');
    expect(bad.getAttribute('aria-setsize')).toBe('2');
    expect(bad.hasAttribute('aria-expanded')).toBe(false);
    expect(bad.textContent).toContain('holds parent');
    expect(bad.textContent).toContain('SMTP 550: mailbox unavailable');
    expect(bad.textContent).toContain('×3');
    expect(host.querySelector('[role="tree"]')?.getAttribute('aria-label')).toBe(
      'Jobs of the flow'
    );
  });

  test('a job removed on completion is drawn as removed, not under its stored state', () => {
    const view = flowView([
      node('r', { state: 'waiting-children' }),
      node('gone', { parentId: 'r', depth: 1, version: null, removed: true, attempts: 0 }),
    ]);
    const { host } = show({ view });
    const gone = treeRow(host, 'gone');
    expect(gone.textContent).toContain('removed');
    expect(gone.textContent).not.toContain('×');
  });

  test('a click selects a line', () => {
    const { host } = show({ view: stuckFlow() });
    click(treeRow(host, 'ok'));
    expect(selectedId(host)).toBe('ok');
    expect(host.querySelector('[role="tree"]')?.getAttribute('aria-activedescendant')).toBe(
      'flow-row-ok'
    );
    click(treeRow(host, 'bad'));
    expect(selectedId(host)).toBe('bad');
  });

  test('the caret opens and shuts what is below a line, without selecting it', () => {
    const { host } = show({ view: stuckFlow() });
    const caret = treeRow(host, 'root').querySelector<HTMLElement>('[aria-hidden="true"]')!;
    click(caret);
    expect(treeRows(host).map(([id]) => id)).toEqual(['root']);
    expect(treeRow(host, 'root').getAttribute('aria-expanded')).toBe('false');
    expect(treeRow(host, 'root').textContent).toContain('2 below');
    expect(selectedId(host)).toBeNull();
    click(caret);
    expect(treeRows(host)).toHaveLength(3);
    expect(selectedId(host)).toBeNull();
  });

  test('Enter and Space on a line select it', () => {
    const { host } = show({ view: stuckFlow() });
    press(treeRow(host, 'bad'), 'Enter');
    expect(selectedId(host)).toBe('bad');
    press(treeRow(host, 'ok'), ' ');
    expect(selectedId(host)).toBe('ok');
  });

  test('arrow keys move through the lines, Home and End go to the ends', () => {
    const { host, tree } = show({ view: stuckFlow() });
    press(tree, 'ArrowDown');
    expect(selectedId(host)).toBe('root');
    press(tree, 'ArrowDown');
    expect(selectedId(host)).toBe('ok');
    press(tree, 'End');
    expect(selectedId(host)).toBe('bad');
    // The last line stays the last line.
    press(tree, 'ArrowDown');
    expect(selectedId(host)).toBe('bad');
    press(tree, 'ArrowUp');
    expect(selectedId(host)).toBe('ok');
    press(tree, 'Home');
    expect(selectedId(host)).toBe('root');
    press(tree, 'ArrowUp');
    expect(selectedId(host)).toBe('root');
    expect(tree.getAttribute('aria-activedescendant')).toBe('flow-row-root');
  });

  test('Left shuts an open line, then goes to its parent; Right opens, then goes to the first child', () => {
    const { host, tree } = show({ view: stuckFlow(), selected: 'bad' });
    press(tree, 'ArrowLeft');
    expect(selectedId(host)).toBe('root');
    press(tree, 'ArrowLeft');
    expect(treeRows(host).map(([id]) => id)).toEqual(['root']);
    expect(selectedId(host)).toBe('root');
    press(tree, 'ArrowRight');
    expect(treeRows(host)).toHaveLength(3);
    expect(selectedId(host)).toBe('root');
    press(tree, 'ArrowRight');
    expect(selectedId(host)).toBe('ok');
    // A line with nothing below does nothing on Right.
    press(tree, 'ArrowRight');
    expect(selectedId(host)).toBe('ok');
  });

  test('other keys are left alone', () => {
    const { host, tree } = show({ view: stuckFlow(), selected: 'ok' });
    press(tree, 'a');
    press(tree, 'Tab');
    expect(selectedId(host)).toBe('ok');
  });

  test('shows nothing but the tree when there are no lines', () => {
    const { host } = show({ view: flowView([node('r')]) });
    expect(treeRows(host)).toEqual([['r', 'completed']]);
  });
});

describe('flow tree at 5,000 jobs', () => {
  const view = syntheticFlow(5_000);

  test('the rows of the whole flow are worked out at once and quickly', () => {
    const tree = buildFlowTree(view.nodes);
    const started = performance.now();
    const rows = flowRows(tree, allParents(tree));
    const elapsed = performance.now() - started;
    expect(rows).toHaveLength(5_000);
    expect(rows[0]?.node.id).toBe('n0');
    expect(elapsed).toBeLessThan(1_000);
  });

  test('opened in full, only a window of lines is in the document', () => {
    const started = performance.now();
    const { host, tree } = show({ view, open: 'all' });
    const elapsed = performance.now() - started;
    const drawn = treeRows(host);
    // 560px of 40px lines is 14, plus 8 either side: far fewer than 5,000.
    expect(drawn.length).toBeGreaterThan(0);
    expect(drawn.length).toBeLessThanOrEqual(30);
    expect(drawn[0]?.[0]).toBe('n0');
    expect(elapsed).toBeLessThan(5_000);
    // The scroll area is as tall as the whole list, so the scrollbar is the right length.
    expect(tree.firstElementChild?.getAttribute('style')).toContain(`height: ${5_000 * 40}px`);
    // A line far down is not drawn until it is scrolled to.
    expect(host.querySelector('[id="flow-row-n4999"]')).toBeNull();
  });

  test('by default only the way down to the failure is open, and selecting it brings it into view', () => {
    const tree = buildFlowTree(view.nodes);
    const rows = flowRows(tree, defaultExpanded(tree));
    // n4999 failed: n0 -> n499 -> n49 -> n4. Only those parents are open, so a few dozen lines, not 5,000.
    expect(rows.length).toBeLessThan(60);
    expect(rows.some((row) => row.node.id === 'n4999')).toBe(true);
    const { host } = show({ view, selected: 'n4999' });
    expect(treeRow(host, 'n4999').textContent).toContain('holds parent');
    expect(selectedId(host)).toBe('n4999');
  });

  test('a selection far down the list is scrolled into the window', () => {
    const { host } = show({ view, open: 'all', selected: 'n4000' });
    const ids = treeRows(host).map(([id]) => id);
    expect(ids).toContain('n4000');
    expect(ids).not.toContain('n0');
    expect(ids.length).toBeLessThanOrEqual(40);
    expect(selectedId(host)).toBe('n4000');
  });

  test('keys still move through a window of the list', () => {
    const tree = buildFlowTree(view.nodes);
    const rows = flowRows(tree, allParents(tree));
    const { host, tree: element } = show({ view, open: 'all' });
    press(element, 'End');
    expect(selectedId(host)).toBe(rows[rows.length - 1]!.node.id);
    expect(treeRows(host).length).toBeLessThanOrEqual(40);
    press(element, 'Home');
    expect(selectedId(host)).toBe('n0');
    press(element, 'ArrowDown');
    press(element, 'ArrowDown');
    expect(element.getAttribute('aria-activedescendant')).toBe(`flow-row-${rows[2]!.node.id}`);
  });
});
