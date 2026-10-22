import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QelayLogo } from '../src/components/brand/QelayLogo';
import { QelayMark, type QelayMarkProps } from '../src/components/brand/QelayMark';
import { ensureDom } from './domSetup';

ensureDom();

const mounted: { container: HTMLDivElement; root: Root }[] = [];

function mount(node: React.ReactNode): HTMLDivElement {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(node));
  mounted.push({ container, root });
  return container;
}

afterEach(() => {
  for (const { container, root } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
});

function gradientRef(svg: Element): string | null {
  const stroke = svg.querySelector('g')?.getAttribute('stroke') ?? '';
  return /^url\(#(.+)\)$/.exec(stroke)?.[1] ?? null;
}

describe('QelayMark', () => {
  test('renders a labelled svg image', () => {
    const svg = mount(<QelayMark />).querySelector('svg');
    expect(svg?.getAttribute('role')).toBe('img');
    expect(svg?.getAttribute('aria-label')).toBe('Qelay mark');
    expect(svg?.getAttribute('viewBox')).toBe('0 0 204 152');
  });

  test('takes a custom accessible name', () => {
    const svg = mount(<QelayMark title="Qelay home" />).querySelector('svg');
    expect(svg?.getAttribute('aria-label')).toBe('Qelay home');
  });

  test('keeps the 204:152 ratio at every size', () => {
    for (const [size, height] of [
      [16, 12],
      [24, 18],
      [34, 25],
      [64, 48],
    ] as const) {
      const svg = mount(<QelayMark size={size} />).querySelector('svg');
      expect(svg?.getAttribute('width')).toBe(String(size));
      expect(svg?.getAttribute('height')).toBe(String(height));
    }
  });

  test('two marks on one page get independent gradients', () => {
    const container = mount(
      <>
        <QelayMark />
        <QelayMark />
      </>
    );
    const [first, second] = [...container.querySelectorAll('svg')];
    const ids = [first, second].map((svg) => svg?.querySelector('linearGradient')?.id);
    expect(ids[0]).toBeTruthy();
    expect(ids[1]).toBeTruthy();
    expect(ids[0]).not.toBe(ids[1]);
    // Each mark paints with its own gradient, and that gradient exists in the page.
    expect(gradientRef(first as Element)).toBe(ids[0] ?? null);
    expect(gradientRef(second as Element)).toBe(ids[1] ?? null);
    expect(container.querySelectorAll('[id]').length).toBe(2);
  });

  test('gradient ids are safe inside url(#…)', () => {
    const id = mount(<QelayMark />).querySelector('linearGradient')?.id ?? '';
    expect(id).toMatch(/^qelay-g-[\w-]+$/);
  });

  test('draws the brand gradient stops', () => {
    const stops = [...mount(<QelayMark />).querySelectorAll('stop')];
    expect(stops.map((s) => s.getAttribute('stop-color'))).toEqual([
      '#FF7A00',
      '#FF3D61',
      '#7A3DFF',
    ]);
  });

  test('mono variant uses the text colour and no gradient', () => {
    const svg = mount(<QelayMark variant="mono" />).querySelector('svg');
    expect(svg?.querySelector('linearGradient')).toBeNull();
    expect(svg?.querySelector('g')?.getAttribute('stroke')).toBe('currentColor');
    expect(svg?.querySelector('circle')?.getAttribute('fill')).toBe('currentColor');
  });

  test('decorative marks are hidden from assistive tech', () => {
    const props: QelayMarkProps = { decorative: true };
    const svg = mount(<QelayMark {...props} />).querySelector('svg');
    expect(svg?.getAttribute('aria-hidden')).toBe('true');
    expect(svg?.hasAttribute('role')).toBe(false);
    expect(svg?.hasAttribute('aria-label')).toBe(false);
  });
});

describe('QelayLogo', () => {
  test('is the mark, the wordmark and the subtitle', () => {
    const container = mount(<QelayLogo />);
    expect(container.textContent).toBe('QelayCloud console');
    expect(container.querySelectorAll('svg').length).toBe(1);
  });

  test('exposes one name to assistive tech, not a mark label plus the text', () => {
    const svg = mount(<QelayLogo />).querySelector('svg');
    expect(svg?.getAttribute('aria-hidden')).toBe('true');
  });

  test('has no gradient on the text and no old branding', () => {
    const html = mount(<QelayLogo />).innerHTML;
    expect(html).not.toMatch(/bun.?queue|dash\b|bg-clip-text/i);
  });
});

describe('public/favicon.svg', () => {
  const svg = readFileSync(new URL('../public/favicon.svg', import.meta.url), 'utf8');

  test('is the Qelay mark on a dark rounded square', () => {
    expect(svg).toContain('<title>Qelay</title>');
    expect(svg).toMatch(/<rect[^>]*rx="\d+"[^>]*fill="#0B0F1A"/);
    expect(svg).toContain('#FF7A00');
    expect(svg).toContain('#7A3DFF');
    // The ring and tail from the mark's geometry.
    expect(svg).toContain('M87 47.3A50 50 0 1 1 87 104.7');
    expect(svg).toContain('M162 110L186 134');
  });

  test('carries no old branding or rabbit shapes', () => {
    expect(svg).not.toMatch(/bun.?queue/i);
    expect(svg).not.toContain('<ellipse');
  });

  test('stays under 2 KB', () => {
    expect(new TextEncoder().encode(svg).length).toBeLessThan(2048);
  });
});
