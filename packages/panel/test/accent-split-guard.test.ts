import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dir, '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx|css)$/.test(entry.name) ? [path] : [];
  });
}

const LINES = sourceFiles(join(ROOT, 'src')).flatMap((file) =>
  readFileSync(file, 'utf8')
    .split('\n')
    .map((text, i) => ({ where: `${relative(ROOT, file)}:${i + 1}`, text }))
);

function offenders(pattern: RegExp): string[] {
  return LINES.filter((line) => pattern.test(line.text)).map((line) => line.where);
}

// Assembled from a variable: Tailwind scans test/ too, and a literal here would emit a dead utility.
const A = 'accent';
const LEGACY_TOKEN = new RegExp(`${A}-fg|${A}-${A}|var\\(--${A}`);

/**
 * The single pink `accent` token became three roles: `primary` (fill), `link` (text) and
 * `ring` (focus, active bar). A leftover utility would render nothing, so it fails here.
 */
describe('accent split', () => {
  test('no accent colour utility, token or tone remains in src', () => {
    // `-accent` catches bg-/text-/border-/ring-/outline-/from-/--color-accent; the lookahead
    // keeps the CSS property `accent-color` and the `accent-ring` utility legal.
    expect(offenders(/-accent(?![\w-])/)).toEqual([]);
    expect(offenders(LEGACY_TOKEN)).toEqual([]);
    expect(offenders(/['"]accent['"]/)).toEqual([]);
  });

  test('a solid orange fill never carries white text (2.61:1)', () => {
    const bad = LINES.filter(
      (line) => /bg-primary(?![\w/-])/.test(line.text) && /text-white/.test(line.text)
    );
    expect(bad.map((line) => line.where)).toEqual([]);
  });

  test('a translucent focus ring is only a glow around a solid ring-coloured border', () => {
    // A bare translucent ring would fall under 3:1 (WCAG 1.4.11). The input pattern pairs a
    // solid `focus:border-ring` with a soft `focus:ring-ring/30` glow, which is fine.
    const bad = LINES.filter(
      (line) =>
        /focus(?:-visible)?:ring-ring\/\d+/.test(line.text) && !/focus:border-ring/.test(line.text)
    );
    expect(bad.map((line) => line.where)).toEqual([]);
  });
});
