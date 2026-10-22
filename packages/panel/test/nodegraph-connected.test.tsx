import { afterEach, describe, expect, test } from 'bun:test';
import { act, createElement, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { ConnectionCard } from '../src/components/ui/nodegraph/ConnectionCard';
import { ConnectionLine } from '../src/components/ui/nodegraph/ConnectionLine';
import { ConnectionNode } from '../src/components/ui/nodegraph/ConnectionNode';
import { ConnectionPill } from '../src/components/ui/nodegraph/ConnectionPill';
import {
  ConnectionGlyph,
  type ConnectionState,
  wireStyle,
} from '../src/components/ui/nodegraph/connectionState';
import { Connector } from '../src/components/ui/nodegraph/Connector';
import { HoverCard } from '../src/components/ui/nodegraph/HoverCard';
import { RuleGlyphs, type RuleView } from '../src/components/ui/nodegraph/RuleGlyph';
import { ensureDom, settle } from './domSetup';

ensureDom();

const STATES: ConnectionState[] = ['active', 'held', 'paused', 'off'];
const WORD = { active: 'Active', held: 'Paused', paused: 'Paused after failures', off: 'Disabled' };

const RULES: RuleView[] = [
  { name: 'Filter', editable: true, on: true, summary: 'Only events that match this are sent.' },
  { name: 'Deduplicate', editable: true, on: false, summary: 'Off: every event is sent.' },
  { name: 'Shape', editable: true, on: false, summary: 'Off: the standard body is sent.' },
  { name: 'Delay', editable: true, on: true, summary: 'Each event waits 5 seconds.' },
  { name: 'Retry', editable: false, on: true, summary: 'Eight attempts.' },
];

const inRouter = (node: ReactElement) => createElement(MemoryRouter, null, node);
const markup = (node: ReactElement) => renderToStaticMarkup(inRouter(node));

const mounted: Array<() => void> = [];
function mount(node: ReactElement) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(inRouter(node)));
  const unmount = () => {
    act(() => root.unmount());
    host.remove();
  };
  mounted.push(unmount);
  return {
    host,
    rerender: (next: ReactElement) => act(() => root.render(inRouter(next))),
  };
}
afterEach(() => {
  while (mounted.length) mounted.pop()?.();
});

function pointer(target: Element, type: 'pointerover' | 'pointerout', pointerType = 'mouse') {
  const event = new window.MouseEvent(type, { bubbles: true });
  Object.defineProperty(event, 'pointerType', { value: pointerType });
  act(() => target.dispatchEvent(event));
}

const card = (
  <HoverCard
    label="Rules of Order delivery"
    trigger={(props) => (
      <ConnectionPill
        to="/gateway/connections/hook-1"
        name="Order delivery"
        state="active"
        stateLabel="Active"
        {...props}
      />
    )}
  >
    <ConnectionCard
      name="Order delivery"
      route="Qelay jobs: orders to hooks.example.test"
      state="active"
      stateLabel="Active"
      rules={RULES}
      fixed={[{ name: 'Retry', label: 'Retry, 8 attempts' }]}
      actions={<a href="/gateway/connections/hook-1">Open</a>}
    />
  </HoverCard>
);

describe('state reads without colour', () => {
  test('each state has its own glyph, and the pill names it in words', () => {
    const glyphs = STATES.map((state) => markup(<ConnectionGlyph state={state} />));
    expect(new Set(glyphs).size).toBe(4);
    for (const state of STATES) {
      const html = markup(
        <ConnectionPill to="/c" name="Order delivery" state={state} stateLabel={WORD[state]} />
      );
      expect(html).toContain(`aria-label="Order delivery, ${WORD[state]}"`);
      expect(html).toContain('aria-hidden="true"');
    }
  });

  test('the line is solid, dashed or dotted, and a held one differs from a live one', () => {
    expect(STATES.map(wireStyle)).toEqual(['solid', 'dashed', 'dashed', 'dotted']);
    const { host } = mount(<ConnectionLine state="off" />);
    expect(host.querySelector('[data-wire]')?.getAttribute('data-wire')).toBe('dotted');
  });

  test('a stopped or off connection outlines its end node instead of filling it', () => {
    const outline = (state: ConnectionState) =>
      markup(<ConnectionNode kind="http" icon="M0 0" name="Order receiver" state={state} />);
    expect(outline('active')).toContain('border-solid');
    expect(outline('held')).toContain('border-dashed');
    expect(outline('paused')).toContain('border-bad');
    expect(outline('off')).toContain('border-dotted');
  });
});

describe('ConnectionLine', () => {
  test('carries no action and draws in once', () => {
    const { host } = mount(<ConnectionLine state="active" index={3} />);
    expect(host.querySelectorAll('a, button, [tabindex]')).toHaveLength(0);
    const wire = host.querySelector('[data-wire]') as HTMLElement;
    expect(wire.className).toContain('motion-draw');
    expect(wire.style.getPropertyValue('--i')).toBe('3');
    expect(wire.getAttribute('aria-hidden')).toBe('true');
  });

  test('no comet on first render, one per real change, none for the same count', () => {
    const { host, rerender } = mount(<ConnectionLine state="active" pulse={0} />);
    const comet = () => host.querySelector('.motion-comet');
    expect(comet()).toBeNull();

    rerender(<ConnectionLine state="active" pulse={1} />);
    const first = comet();
    expect(first).not.toBeNull();

    rerender(<ConnectionLine state="active" pulse={1} />);
    expect(comet()).toBe(first);

    rerender(<ConnectionLine state="active" pulse={2} />);
    expect(comet()).not.toBe(first);
    expect(host.querySelectorAll('.motion-comet')).toHaveLength(1);
  });
});

describe('RuleGlyphs', () => {
  test('draws only the rules this connection set and left on', () => {
    const { host } = mount(<RuleGlyphs rules={RULES} />);
    expect(
      [...host.querySelectorAll('[role="img"]')].map((el) => el.getAttribute('aria-label'))
    ).toEqual(['Filter', 'Delay']);
  });
});

describe('HoverCard', () => {
  test('opens on focus, lists the rules in order, and leaves focus where it was', () => {
    const { host } = mount(card);
    const pill = host.querySelector('a[aria-label]') as HTMLAnchorElement;
    expect(host.querySelector('[role="group"]')).toBeNull();
    expect(pill.getAttribute('aria-expanded')).toBe('false');

    act(() => pill.focus());
    const group = host.querySelector('[role="group"]');
    expect(group?.getAttribute('aria-label')).toBe('Rules of Order delivery');
    expect(pill.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(pill);

    const names = [...(group?.querySelectorAll('li b') ?? [])].map((el) => el.textContent);
    expect(names).toEqual(['Filter', 'Deduplicate', 'Shape', 'Delay']);
    expect(group?.textContent).toContain('Retry, 8 attempts');
    expect(group?.querySelector('a')?.textContent).toBe('Open');
  });

  test('Escape closes it at once for input, and it is gone after the leave', async () => {
    const { host } = mount(card);
    const pill = host.querySelector('a[aria-label]') as HTMLAnchorElement;
    act(() => pill.focus());
    act(() => {
      pill.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(pill.getAttribute('aria-expanded')).toBe('false');
    await settle(260);
    expect(host.querySelector('[role="group"]')).toBeNull();
    expect(document.activeElement).toBe(pill);
  });

  test('closes when focus leaves', async () => {
    const { host } = mount(card);
    const pill = host.querySelector('a[aria-label]') as HTMLAnchorElement;
    act(() => pill.focus());
    act(() => pill.blur());
    expect(pill.getAttribute('aria-expanded')).toBe('false');
    await settle(260);
    expect(host.querySelector('[role="group"]')).toBeNull();
  });

  test('a mouse opens it and closes it 120ms after leaving; a finger does not open it', async () => {
    const { host } = mount(card);
    const pill = host.querySelector('a[aria-label]') as HTMLAnchorElement;

    pointer(pill, 'pointerover', 'touch');
    expect(host.querySelector('[role="group"]')).toBeNull();

    pointer(pill, 'pointerover');
    expect(host.querySelector('[role="group"]')).not.toBeNull();

    pointer(pill, 'pointerout');
    await settle(60);
    expect(pill.getAttribute('aria-expanded')).toBe('true');
    // Each wait is its own act scope, so the 120ms close renders before the 180ms leave timer starts.
    await settle(100);
    expect(pill.getAttribute('aria-expanded')).toBe('false');
    await settle(260);
    expect(host.querySelector('[role="group"]')).toBeNull();
  });
});

describe('what already uses the canvas parts', () => {
  test('Connector without an index renders exactly as before', () => {
    const html = renderToStaticMarkup(
      <svg>
        <Connector x1={0} y1={0} x2={100} y2={40} />
      </svg>
    );
    expect(html).not.toContain('motion-draw');
    expect(html).not.toContain('stroke-dasharray');
    expect(html).toContain('stroke-faint');
  });

  test('Connector with an index draws in, and a dashed one carries its dash', () => {
    const html = renderToStaticMarkup(
      <svg>
        <Connector x1={0} y1={0} x2={100} y2={40} index={2} dash="dashed" />
      </svg>
    );
    expect(html).toContain('class="motion-draw"');
    expect(html).toContain('--i:2');
    expect(html).toContain('stroke-dasharray="6 5"');
  });
});
