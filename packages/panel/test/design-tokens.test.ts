import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

// The palette is in tokens.css, imported by index.css; tokens go first so the @theme slice ends at index.css.
const CSS = ['tokens', 'index']
  .map((name) => readFileSync(new URL(`../src/${name}.css`, import.meta.url), 'utf8'))
  .join('\n');

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
  test('matches the WCAG reference values', () => {
    expect(contrast(rgb('#000000'), rgb('#ffffff'))).toBeCloseTo(21, 5);
    expect(contrast(rgb('#1f4438'), rgb('#e0f3e6'))).toBeCloseTo(9.34, 1);
    expect(contrast(rgb('#ffffff'), rgb('#1f4438'))).toBeCloseTo(10.81, 1);
    expect(contrast(rgb('#7d8e9e'), rgb('#ffffff'))).toBeCloseTo(3.37, 1);
    expect(contrast(rgb('#c8860b'), rgb('#ffffff'))).toBeCloseTo(3.06, 1);
  });
});

const TEXT_ON_SURFACES: Record<Theme, { text: string[]; on: string[] }> = {
  dark: {
    text: ['text', 'text-muted', 'text-faint', 'link', 'danger', 'success', 'warning'],
    on: ['bg', 'surface', 'surface-2'],
  },
  light: {
    text: ['text', 'text-muted', 'text-faint', 'link', 'danger', 'success', 'warning'],
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

/** Opaque colour of token `name` on a selected row (the translucent wash sits over --surface). */
function onSelected(theme: Theme, name: string): [Rgb, Rgb] {
  const wash = over(parseColour(token(theme, 'selected')), seenOn(theme, 'surface', 'bg'));
  return [over(parseColour(token(theme, name)), wash), wash];
}

describe.each(['dark', 'light'] as const)('%s theme selected row', (theme) => {
  for (const fg of ['text', 'text-muted', 'text-faint', 'link']) {
    test(`--${fg} on the selected wash is at least 4.5:1`, () => {
      const [text, wash] = onSelected(theme, fg);
      expect(contrast(text, wash)).toBeGreaterThanOrEqual(4.5);
    });
  }
});

describe.each(['dark', 'light'] as const)('%s theme non-text edges and glyphs', (theme) => {
  for (const bg of ['bg', 'surface', 'surface-2']) {
    test(`--line-strong on --${bg} is at least 3:1`, () => {
      expect(ratio(theme, 'line-strong', bg)).toBeGreaterThanOrEqual(3);
    });
  }

  for (const glyph of ['ok', 'warn', 'bad', 'active', 'idle', 'hl']) {
    test(`--${glyph} on --surface is at least 3:1`, () => {
      expect(ratio(theme, glyph, 'surface')).toBeGreaterThanOrEqual(3);
    });
  }
});

describe.each(['dark', 'light'] as const)('%s theme primary action and focus', (theme) => {
  test('--primary-fg on --primary is at least 4.5:1', () => {
    expect(
      contrast(seenOn(theme, 'primary-fg', 'bg'), seenOn(theme, 'primary', 'bg'))
    ).toBeGreaterThanOrEqual(4.5);
  });

  test('--primary stands out from the page ground by at least 3:1', () => {
    expect(
      contrast(seenOn(theme, 'primary', 'bg'), seenOn(theme, 'bg', 'bg'))
    ).toBeGreaterThanOrEqual(3);
  });

  for (const bg of ['bg', 'surface', 'surface-2']) {
    test(`--ring on --${bg} is at least 3:1`, () => {
      expect(ratio(theme, 'ring', bg)).toBeGreaterThanOrEqual(3);
    });
  }

  test('the switch thumb (--on-ok) on the on track (--ok) is at least 3:1', () =>
    expect(ratio(theme, 'on-ok', 'ok')).toBeGreaterThanOrEqual(3));
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
      'ok',
      'warn',
      'bad',
      'active',
      'idle',
      'hl',
      'rose',
      'slate-tint',
      'danger-tint',
      'on-ok',
      ...STATES.flatMap((s) => [`state-${s}-bg`, `state-${s}-fg`]),
    ];
    for (const role of roles) {
      expect(theme).toContain(`--color-${role}: var(--${role});`);
      expect(TOKENS.dark.has(`--${role}`)).toBe(true);
      expect(TOKENS.light.has(`--${role}`)).toBe(true);
    }
  });

  test('card and popover shadows are per-theme tokens (shadow-panel, shadow-pop)', () => {
    expect(theme).toContain('--shadow-panel: var(--panel-shadow);');
    expect(theme).toContain('--shadow-pop: var(--pop-shadow);');
    expect(TOKENS.dark.get('--panel-shadow')).toBe('none');
    expect(TOKENS.light.get('--panel-shadow')).not.toBe('none');
    expect(TOKENS.light.has('--pop-shadow') && TOKENS.dark.has('--pop-shadow')).toBe(true);
  });

  test('every role the panel was built on is still defined in both themes', () => {
    const core = [
      'bg',
      'surface',
      'surface-2',
      'line',
      'line-strong',
      'text',
      'text-muted',
      'text-faint',
      'sidebar',
      'success',
      'warning',
      'danger',
      'brand-1',
      'brand-2',
      'brand-3',
    ];
    for (const name of core) {
      expect(TOKENS.dark.has(`--${name}`), `dark --${name}`).toBe(true);
      expect(TOKENS.light.has(`--${name}`), `light --${name}`).toBe(true);
    }
  });

  test('declares the compact radii: card 8, field 6, segment 6, key 4', () => {
    expect(theme).toContain('--radius-card: 8px;');
    expect(theme).toContain('--radius-control: 6px;');
    expect(theme).toContain('--radius-segment: 6px;');
    expect(theme).toContain('--radius-kbd: 4px;');
  });

  test('keyboard focus is one 2px ring with a 2px offset, in --ring', () => {
    expect(CSS).toMatch(
      /:focus-visible \{\s*outline: 2px solid var\(--ring\);\s*outline-offset: 2px;\s*\}/
    );
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
  test('.eyebrow is 11px / 600 / 0.08em / uppercase', () => {
    const eyebrow = CSS.slice(
      CSS.indexOf('.eyebrow {'),
      CSS.indexOf('}', CSS.indexOf('.eyebrow {'))
    );
    expect(eyebrow).toContain('font-size: 11px;');
    expect(eyebrow).toContain('font-weight: 600;');
    expect(eyebrow).toContain('letter-spacing: 0.08em;');
    expect(eyebrow).toContain('text-transform: uppercase;');
  });
});
