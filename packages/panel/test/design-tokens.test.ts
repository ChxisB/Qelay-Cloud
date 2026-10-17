import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const CSS = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8');
const FONTS = readFileSync(new URL('../src/fonts.css', import.meta.url), 'utf8');

type Rgb = readonly [number, number, number];
type Rgba = readonly [number, number, number, number];
type Theme = 'dark' | 'light';

/** Body of the first rule whose selector line starts with `selector`. */
function block(selector: string): string {
  const start = CSS.indexOf(`${selector} {`);
  if (start === -1) throw new Error(`index.css has no "${selector}" block`);
  return CSS.slice(start, CSS.indexOf('\n}', start));
}

function declarations(body: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of body.matchAll(/^\s*(--[\w-]+):\s*([^;]+);/gm)) {
    out.set(m[1] ?? '', (m[2] ?? '').trim());
  }
  return out;
}

const TOKENS: Record<Theme, Map<string, string>> = {
  // `:root, [data-theme="dark"]` is the default; the light block overrides on top of it.
  dark: declarations(block('[data-theme="dark"]')),
  light: new Map([
    ...declarations(block('[data-theme="dark"]')),
    ...declarations(block('[data-theme="light"]')),
  ]),
};

function parseColour(value: string): Rgba {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value);
  if (hex) {
    const h = hex[1] ?? '';
    const full = h.length === 3 ? [...h].map((c) => c + c).join('') : h;
    const n = Number.parseInt(full, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
  }
  const rgba = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(value);
  if (rgba) return [Number(rgba[1]), Number(rgba[2]), Number(rgba[3]), Number(rgba[4] ?? 1)];
  throw new Error(`unsupported colour "${value}"`);
}

function token(theme: Theme, name: string): string {
  const v = TOKENS[theme].get(`--${name}`);
  if (v === undefined) throw new Error(`--${name} is not defined for ${theme}`);
  return v;
}

/** Composite a possibly translucent colour over an opaque backdrop. */
function over(fg: Rgba, backdrop: Rgb): Rgb {
  const [r, g, b, a] = fg;
  return [
    r * a + backdrop[0] * (1 - a),
    g * a + backdrop[1] * (1 - a),
    b * a + backdrop[2] * (1 - a),
  ];
}

function luminance([r, g, b]: Rgb): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const WHITE: Rgb = [255, 255, 255];
const rgb = (hex: string): Rgb => over(parseColour(hex), WHITE);

/** Opaque colour of token `name` seen on token `on` (translucent tokens are blended). */
function seenOn(theme: Theme, name: string, on: string): Rgb {
  const backdrop = over(parseColour(token(theme, on)), WHITE);
  return over(parseColour(token(theme, name)), backdrop);
}

function ratio(theme: Theme, fg: string, bg: string): number {
  return contrast(seenOn(theme, fg, bg), seenOn(theme, bg, 'bg'));
}

describe('contrast helper', () => {
  test('matches the values quoted in the design', () => {
    expect(contrast(rgb('#000000'), rgb('#ffffff'))).toBeCloseTo(21, 5);
    expect(contrast(rgb('#0b0f1a'), rgb('#ff7a00'))).toBeCloseTo(7.32, 1);
    expect(contrast(rgb('#a98bff'), rgb('#0b0f1a'))).toBeCloseTo(7.13, 1);
    expect(contrast(rgb('#7a3dff'), rgb('#0b0f1a'))).toBeCloseTo(3.59, 1);
    expect(contrast(rgb('#64748b'), rgb('#0b0f1a'))).toBeCloseTo(4.02, 1);
  });
});

const TEXT_ON_SURFACES: Record<Theme, { text: string[]; on: string[] }> = {
  dark: {
    text: ['text', 'text-muted', 'text-faint', 'link', 'danger', 'success', 'warning'],
    on: ['bg', 'surface', 'surface-2'],
  },
  light: {
    text: ['text', 'text-muted', 'link', 'danger', 'success', 'warning'],
    on: ['bg', 'surface', 'surface-2', 'sidebar'],
  },
};

describe.each(['dark', 'light'] as const)('%s theme text contrast', (theme) => {
  const { text, on } = TEXT_ON_SURFACES[theme];
  for (const fg of text) {
    for (const bg of on) {
      test(`--${fg} on --${bg} is at least 4.5:1`, () => {
        expect(ratio(theme, fg, bg)).toBeGreaterThanOrEqual(4.5);
      });
    }
  }
});

describe('light --text-faint', () => {
  // Documented limit: it is only AA on white surfaces, so it must not be used on --surface-2 / --sidebar.
  for (const bg of ['bg', 'surface']) {
    test(`--text-faint on --${bg} is at least 4.5:1`, () => {
      expect(ratio('light', 'text-faint', bg)).toBeGreaterThanOrEqual(4.5);
    });
  }
});

describe.each(['dark', 'light'] as const)('%s theme primary action and focus', (theme) => {
  test('--primary-fg on --primary is at least 4.5:1', () => {
    expect(
      contrast(seenOn(theme, 'primary-fg', 'bg'), seenOn(theme, 'primary', 'bg'))
    ).toBeGreaterThanOrEqual(4.5);
  });

  for (const bg of ['bg', 'surface', 'surface-2']) {
    test(`--ring on --${bg} is at least 3:1`, () => {
      expect(ratio(theme, 'ring', bg)).toBeGreaterThanOrEqual(3);
    });
  }
});

const STATES = ['waiting', 'prioritized', 'active', 'completed', 'failed', 'delayed'] as const;

describe.each(['dark', 'light'] as const)('%s theme job-state pills', (theme) => {
  for (const state of STATES) {
    test(`${state}: text on its pill (over --surface) is at least 4.5:1`, () => {
      const surface = seenOn(theme, 'surface', 'bg');
      const pill = over(parseColour(token(theme, `state-${state}-bg`)), surface);
      const fg = over(parseColour(token(theme, `state-${state}-fg`)), pill);
      expect(contrast(fg, pill)).toBeGreaterThanOrEqual(4.5);
    });
  }
});

describe('token registration', () => {
  const theme = CSS.slice(CSS.indexOf('@theme inline'));

  test('every role is exposed to Tailwind as --color-*', () => {
    const roles = [
      'primary',
      'primary-fg',
      'link',
      'ring',
      'selected',
      'hover',
      'segment-active',
      'danger-fill',
      ...STATES.flatMap((s) => [`state-${s}-bg`, `state-${s}-fg`]),
    ];
    for (const role of roles) {
      expect(theme).toContain(`--color-${role}: var(--${role});`);
      expect(TOKENS.dark.has(`--${role}`)).toBe(true);
      expect(TOKENS.light.has(`--${role}`)).toBe(true);
    }
  });

  test('declares the Qelay radii', () => {
    expect(theme).toContain('--radius-card: 14px;');
    expect(theme).toContain('--radius-control: 10px;');
    expect(theme).toContain('--radius-segment: 7px;');
    expect(theme).toContain('--radius-kbd: 6px;');
  });

  test('the legacy --accent pair is gone from both themes and from @theme', () => {
    for (const theme of ['dark', 'light'] as const) {
      expect(TOKENS[theme].has('--accent')).toBe(false);
      expect(TOKENS[theme].has('--accent-fg')).toBe(false);
    }
    expect(CSS).not.toContain('--color-accent');
  });
});

describe('type', () => {
  test('Inter stays; JetBrains Mono and the stylistic feature flags are gone', () => {
    expect(FONTS).toContain("font-family: 'Inter Variable'");
    expect(FONTS).not.toMatch(/jetbrains/i);
    expect(CSS).not.toMatch(/jetbrains/i);
    expect(CSS).not.toContain('cv11');
    expect(CSS).not.toContain('ss01');
  });

  test('the mono stack is the system stack', () => {
    expect(CSS).toContain("--font-mono: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;");
  });

  test('.eyebrow is 11px / 600 / 0.18em / uppercase', () => {
    const eyebrow = CSS.slice(
      CSS.indexOf('.eyebrow {'),
      CSS.indexOf('}', CSS.indexOf('.eyebrow {'))
    );
    expect(eyebrow).toContain('font-size: 11px;');
    expect(eyebrow).toContain('font-weight: 600;');
    expect(eyebrow).toContain('letter-spacing: 0.18em;');
    expect(eyebrow).toContain('text-transform: uppercase;');
  });
});
