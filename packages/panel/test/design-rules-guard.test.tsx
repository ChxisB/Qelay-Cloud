import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { StatusGlyph } from '../src/components/ui/StatusBadge';
import type { StateRole } from '../src/components/ui/StatusBadge';

const ROOT = join(import.meta.dir, '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

const LINES = sourceFiles(join(ROOT, 'src')).flatMap((file) =>
  readFileSync(file, 'utf8')
    .split('\n')
    .map((text, i) => ({
      file: relative(ROOT, file),
      where: `${relative(ROOT, file)}:${i + 1}`,
      text,
    }))
);

// Assembled from parts: Tailwind scans test/ too, and a literal here would emit a dead utility.
const NO_OUTLINE = new RegExp(['focus(?:-visible)?:outline', 'none'].join('-'));
const BARE_NO_OUTLINE = new RegExp(['(?<![:\\w-])outline', 'none(?![\\w-])'].join('-'));
const WRAPPER_RING = ['focus-within:outline', '2'].join('-');

/**
 * The 2px `:focus-visible` outline in index.css (pinned by design-tokens.test.ts) is the one
 * keyboard focus indicator. A page that swaps it for a thinner ring is a second, weaker one.
 */
describe('keyboard focus', () => {
  test('no element opts out of the global focus outline', () => {
    const bad = LINES.filter((line) => NO_OUTLINE.test(line.text));
    expect(bad.map((line) => line.where)).toEqual([]);
  });

  test('a bare input outline is allowed only where its wrapper draws the 2px ring', () => {
    // SearchField and LogSearch wrap the input; NodeSwitcher overlays an invisible select on a
    // pill. In each, the wrapper carries `focus-within` with the same 2px outline.
    const files = [
      ...new Set(LINES.filter((l) => BARE_NO_OUTLINE.test(l.text)).map((l) => l.file)),
    ];
    expect(files.sort()).toEqual([
      'src/components/layout/NodeSwitcher.tsx',
      'src/components/ui/LogViewer.tsx',
      'src/components/ui/SearchField.tsx',
    ]);
    for (const file of files) {
      expect(readFileSync(join(ROOT, file), 'utf8'), file).toContain(WRAPPER_RING);
    }
  });
});

/**
 * Status is never carried by colour alone: every state pill has its word and a glyph, and the six
 * glyphs differ in shape, so a viewer who cannot tell two hues apart can still tell the states
 * apart. (StatusBadge renders glyph and word for every mapped status: state-colours.test.tsx.)
 */
describe('status glyphs', () => {
  const ROLES: StateRole[] = ['waiting', 'prioritized', 'active', 'completed', 'failed', 'delayed'];

  test('each of the six states draws a different shape', () => {
    // The colour class is the only thing that may differ, so it is dropped before comparing.
    const shape = (state: StateRole) =>
      renderToStaticMarkup(<StatusGlyph state={state} />).replace(/ class="[^"]*"/g, '');
    expect(new Set(ROLES.map(shape)).size).toBe(ROLES.length);
  });

  test('a glyph is decorative: hidden from assistive tech and not focusable', () => {
    for (const state of ROLES) {
      const svg = renderToStaticMarkup(<StatusGlyph state={state} small />);
      expect(svg, state).toContain('aria-hidden="true"');
      expect(svg, state).toContain('focusable="false"');
    }
  });
});
