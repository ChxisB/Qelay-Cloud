import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

function files(dir: string, pattern: RegExp): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return files(path, pattern);
    return pattern.test(entry.name) ? [path] : [];
  });
}

function linesOf(pattern: RegExp) {
  return files(join(ROOT, 'src'), pattern).flatMap((file) =>
    readFileSync(file, 'utf8')
      .split('\n')
      .map((text, i) => ({ where: `${relative(ROOT, file)}:${i + 1}`, text }))
  );
}

// Class names are assembled: Tailwind scans test/ too, and a literal here would emit a dead utility.
const DURATION = ['duration', ''].join('-');
const RAW_DURATION = new RegExp(`(?<![\\w-])${DURATION}(\\d|\\[)`);
// A time written into a style prop or an inline transition or animation instead of a token.
const RAW_INLINE_MS =
  /(transition|animation)[A-Za-z]*\s*[:=]\s*[^;,}\n]*[^\w.-]\d+(\.\d+)?\s?m?s\b/;

const MOTION_TOKENS: Record<string, string> = {
  '--duration-press': '160ms',
  '--duration-hover': '240ms',
  '--dur-enter': '300ms',
  '--dur-exit': '180ms',
  '--dur-stagger': '40ms',
  '--dur-draw': '600ms',
  '--dur-flow': '900ms',
  '--ease-settle': 'cubic-bezier(0.22,1,0.36,1)',
  '--ease-exit': 'cubic-bezier(0.4,0,1,1)',
  '--ease-pop': 'cubic-bezier(0.34,1.56,0.64,1)',
};
const MOTION_NAME = /^\s*(--(?:duration|dur|ease)-[\w-]+):\s*([^;]+);/gm;

type Line = { where: string; text: string };

function rawDurations(lines: Line[]): string[] {
  return lines
    .filter((line) => RAW_DURATION.test(line.text) || RAW_INLINE_MS.test(line.text))
    .map((line) => line.where);
}

/** Every `@keyframes` outside the one file allowed to define them. */
function strayKeyframes(sources: { where: string; text: string }[], allowed: string): string[] {
  return sources
    .filter((source) => source.where !== allowed && source.text.includes('@keyframes'))
    .map((source) => source.where);
}

/** Cuts every block whose opening line matches `opener`, matching braces. */
function stripBlocks(css: string, opener: RegExp): string {
  let out = '';
  let rest = css;
  for (let m = opener.exec(rest); m; m = opener.exec(rest)) {
    const open = rest.indexOf('{', m.index);
    let depth = 0;
    let end = open;
    for (; end < rest.length; end++) {
      if (rest[end] === '{') depth++;
      if (rest[end] === '}' && --depth === 0) break;
    }
    out += rest.slice(0, m.index);
    rest = rest.slice(end + 1);
  }
  return out + rest;
}

/**
 * What is left of a stylesheet once the places that may name motion are cut out: the no-preference query, keyframes
 * (they define, they do not apply), the reduced-motion backstop (it only switches motion off) and the easing
 * utilities (a timing function alone starts nothing).
 */
function outsideMotionBlocks(css: string): string {
  return [
    /@media \(prefers-reduced-motion: no-preference\)/,
    /@media \(prefers-reduced-motion: reduce\)/,
    /@keyframes [\w-]+/,
    /@utility ease-[\w-]+/,
  ].reduce(stripBlocks, css);
}

/** `animation` or `transition` declared outside the no-preference query. */
function unguardedMotion(css: string): string[] {
  return outsideMotionBlocks(css)
    .split('\n')
    .filter((line) => /^\s*(animation|transition)[\w-]*\s*:/.test(line));
}

/** An `animation` or `transition` declaration that spells out a time instead of a `var(--dur-…)`. */
function rawCssTimes(css: string): string[] {
  return stripBlocks(css, /@media \(prefers-reduced-motion: reduce\)/)
    .split('\n')
    .filter((line) => /^\s*(animation|transition)[\w-]*\s*:[^;]*[^\w.-]\d*\.?\d+m?s\b/.test(line));
}

const cssFiles = () =>
  files(join(ROOT, 'src'), /\.css$/).map((file) => ({
    where: relative(ROOT, file),
    text: readFileSync(file, 'utf8'),
  }));

describe('motion tokens', () => {
  const tokens = read('src/tokens.css');
  const lightEnd = tokens.indexOf('\n}', tokens.indexOf('[data-theme="light"] {'));
  const start = tokens.indexOf('\n:root {');
  const body = start === -1 ? '' : tokens.slice(start, tokens.indexOf('\n}', start));
  const declared = new Map(
    [...body.matchAll(MOTION_NAME)].map((m) => [m[1] ?? '', (m[2] ?? '').replace(/\s/g, '')])
  );

  test('the ten tokens carry the approved values', () => {
    expect(Object.fromEntries(declared)).toEqual(MOTION_TOKENS);
  });

  test('they sit in one :root block after both theme blocks, and nowhere else', () => {
    expect(start).toBeGreaterThan(lightEnd);
    expect([...tokens.matchAll(MOTION_NAME)]).toHaveLength(Object.keys(MOTION_TOKENS).length);
  });

  test('the easings are utilities', () => {
    const index = read('src/index.css');
    for (const name of ['settle', 'exit', 'pop']) {
      expect(index).toMatch(
        new RegExp(
          `@utility ease-${name} \\{\\s*transition-timing-function: var\\(--ease-${name}\\);`
        )
      );
    }
  });

  test('the reduced-motion backstop is still in index.css', () => {
    const index = read('src/index.css');
    const reduce = index.slice(index.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(reduce).toContain('animation-duration: 0.01ms !important;');
    expect(reduce).toContain('animation-iteration-count: 1 !important;');
    expect(reduce).toContain('transition-duration: 0.01ms !important;');
    expect(reduce).toContain('scroll-behavior: auto !important;');
  });
});

describe('raw durations', () => {
  const code = linesOf(/\.tsx?$/);

  test('a time comes from a token, not a number, and there is no allowlist', () => {
    expect(rawDurations(code)).toEqual([]);
  });

  test('a time in a stylesheet comes from a token too', () => {
    const bad = cssFiles().flatMap(({ where, text }) =>
      rawCssTimes(text).map((l) => `${where}: ${l}`)
    );
    expect(bad).toEqual([]);
    expect(rawCssTimes('.x {\n  transition: opacity 200ms;\n}')).toEqual([
      '  transition: opacity 200ms;',
    ]);
    expect(rawCssTimes('.x {\n  animation: a var(--dur-enter) var(--ease-settle);\n}')).toEqual([]);
  });

  test('the rule catches what it should and passes the token form', () => {
    const at = (text: string) => rawDurations([{ where: 'x:1', text }]);
    expect(at(`<i className="transition ${DURATION}150" />`)).toEqual(['x:1']);
    expect(at(`<i className="${DURATION}[250ms]" />`)).toEqual(['x:1']);
    expect(at(`<i style={{ transitionDuration: '200ms' }} />`)).toEqual(['x:1']);
    expect(at(`<i style={{ animationDelay: '40ms' }} />`)).toEqual(['x:1']);
    expect(at(`<i className="${DURATION}(--duration-press)" />`)).toEqual([]);
    expect(at(`<i style={{ animationDelay: 'calc(var(--i) * var(--dur-stagger))' }} />`)).toEqual(
      []
    );
    expect(at('const timeout = 3000; // ms, not a style')).toEqual([]);
  });
});

describe('keyframes and the no-preference query', () => {
  const sources = files(join(ROOT, 'src'), /\.(css|tsx?)$/).map((file) => ({
    where: relative(ROOT, file),
    text: readFileSync(file, 'utf8'),
  }));

  test('@keyframes live only in src/motion.css', () => {
    expect(strayKeyframes(sources, 'src/motion.css')).toEqual([]);
    expect(
      strayKeyframes([{ where: 'src/x.css', text: '@keyframes a {}' }], 'src/motion.css')
    ).toEqual(['src/x.css']);
  });

  test('every animation and transition in every stylesheet sits inside no-preference', () => {
    const bad = cssFiles().flatMap(({ where, text }) =>
      unguardedMotion(text).map((line) => `${where}: ${line.trim()}`)
    );
    expect(bad).toEqual([]);
  });

  test('a presence user never holds a node past the exit time, or at all under reduced motion', () => {
    const readers = files(join(ROOT, 'src'), /\.tsx?$/)
      .filter((file) => readFileSync(file, 'utf8').includes('EXIT_MS'))
      .map((file) => relative(ROOT, file))
      .sort();
    expect(readers).toEqual(['src/lib/useLeavers.ts', 'src/lib/usePresence.ts']);
    expect(read('src/lib/usePresence.ts')).toContain(
      'setTimeout(() => setMounted(false), reduced ? 0 : EXIT_MS)'
    );
    expect(read('src/lib/usePresence.ts')).toContain('mounted: open || (mounted && !reduced)');
    expect(read('src/lib/useLeavers.ts')).toContain('if (!reducedMotion())');
  });

  test('motion.css is imported, names its patterns, and moves only transform and opacity', () => {
    expect(read('src/index.css')).toContain('@import "./motion.css";');
    const css = read('src/motion.css');
    const names = [
      'arrive',
      'leave',
      'stagger',
      'flash',
      'draw',
      'draw-y',
      'fill',
      'comet',
      'comet-y',
      'pop',
      'ping',
      'step',
    ];
    for (const name of names) {
      expect(css).toContain(`.motion-${name}`);
    }
    const moved = [...css.matchAll(/@keyframes [\w-]+ \{([\s\S]*?)\n\}/g)].flatMap((m) =>
      [...(m[1] ?? '').matchAll(/^\s+([a-z-]+):/gm)].map((p) => p[1])
    );
    expect(moved.filter((p) => p && !['opacity', 'transform'].includes(p))).toEqual([]);
  });

  test('usePresence waits as long as --dur-exit', () => {
    const exit = Number(/--dur-exit:\s*(\d+)ms/.exec(read('src/tokens.css'))?.[1]);
    expect(exit).toBeGreaterThan(0);
    expect(read('src/lib/usePresence.ts')).toContain(`const EXIT_MS = ${exit};`);
  });

  test('the rule catches an unguarded animation and passes a guarded one', () => {
    const guarded = `@keyframes a { from { opacity: 0 } }
@media (prefers-reduced-motion: no-preference) {
  .x { animation: a 1s; }
}`;
    expect(unguardedMotion(guarded)).toEqual([]);
    expect(unguardedMotion(`${guarded}\n.y {\n  transition: opacity 1s;\n}`)).toEqual([
      '  transition: opacity 1s;',
    ]);
  });
});
