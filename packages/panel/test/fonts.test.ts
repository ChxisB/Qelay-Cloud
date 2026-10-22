import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const read = (file: string) => readFileSync(join(ROOT, file), 'utf8');
const FONTS = read('src/fonts.css');
const TOKENS = read('src/index.css');
const PKG = JSON.parse(read('package.json')) as { dependencies: Record<string, string> };

const FACES = [
  { pkg: 'plus-jakarta-sans', family: 'Plus Jakarta Sans Variable', weights: '200 800' },
  { pkg: 'jetbrains-mono', family: 'JetBrains Mono Variable', weights: '100 800' },
];

describe('fonts', () => {
  test('both designed families are dependencies and Inter is gone', () => {
    for (const { pkg } of FACES)
      expect(PKG.dependencies).toHaveProperty(`@fontsource-variable/${pkg}`);
    expect(PKG.dependencies).not.toHaveProperty('@fontsource-variable/inter');
    expect(FONTS + TOKENS).not.toMatch(/inter variable|fontsource-variable\/inter\b/i);
  });

  test('each family has a latin and a latin-ext face, variable and swapping', () => {
    for (const { family, weights } of FACES) {
      const faces = FONTS.split('@font-face').filter((f) => f.includes(`font-family: '${family}'`));
      expect(faces.map((f) => /-(latin(?:-ext)?)-wght-normal/.exec(f)?.[1]).sort()).toEqual([
        'latin',
        'latin-ext',
      ]);
      for (const face of faces) {
        expect(face).toContain(`font-weight: ${weights};`);
        expect(face).toContain('font-display: swap;');
        expect(face).toContain("format('woff2-variations')");
      }
    }
  });

  test('every file is one the installed package ships; nothing comes from another host', () => {
    const urls = [...FONTS.matchAll(/url\('([^']+)'\)/g)].map((m) => m[1] ?? '');
    expect(urls).toHaveLength(4);
    for (const url of urls) {
      expect(url).toMatch(/^@fontsource-variable\/[\w-]+\/files\/[\w-]+\.woff2$/);
      const [scope, pkg, ...rest] = url.split('/');
      expect(existsSync(join(ROOT, 'node_modules', `${scope}/${pkg}`, ...rest))).toBe(true);
    }
    expect(FONTS + TOKENS).not.toMatch(/https?:\/\//);
  });

  test('the stacks lead with the designed family and keep a system fallback', () => {
    expect(TOKENS).toContain(
      "--font-sans: 'Plus Jakarta Sans Variable', ui-sans-serif, system-ui, sans-serif;"
    );
    expect(TOKENS).toContain(
      "--font-mono: 'JetBrains Mono Variable', ui-monospace, 'SF Mono', Menlo, Consolas, monospace;"
    );
  });

  test('no stylistic feature flags are switched on', () => {
    expect(TOKENS).not.toContain('cv11');
    expect(TOKENS).not.toContain('ss01');
  });
});
