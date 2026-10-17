import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dir, '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

function linesOf(dir: string) {
  return sourceFiles(join(ROOT, dir)).flatMap((file) =>
    readFileSync(file, 'utf8')
      .split('\n')
      .map((text, i) => ({ where: `${relative(ROOT, file)}:${i + 1}`, text }))
  );
}

const UI = linesOf('src/components/ui');
const SRC = linesOf('src');

// Assembled from a variable: Tailwind scans test/ too, and a literal here would emit a dead utility.
const WHITE = ['text', 'white'].join('-');

function offenders(lines: typeof UI, pattern: RegExp): string[] {
  return lines.filter((line) => pattern.test(line.text)).map((line) => line.where);
}

/**
 * The shapes come from tokens: cards `rounded-card` (14), controls `rounded-control` (10),
 * badges pills. The shared primitives therefore never hard-code a larger Tailwind radius, and
 * the old card idiom does not creep back into pages.
 */
describe('ui primitive radii', () => {
  test('no rounded-lg, -xl or -2xl in src/components/ui', () => {
    expect(offenders(UI, /rounded-(lg|xl|2xl)(?![\w-])/)).toEqual([]);
  });

  test('rounded-md in ui/ is limited to the small intentional chips', () => {
    // Pagination links + current page, the 24px CopyButton, the OfflineBanner retry. They are
    // dense inline affordances, not controls on the components board.
    const allowed = new Set([
      'src/components/ui/Pagination.tsx',
      'src/components/ui/CopyButton.tsx',
      'src/components/ui/feedback.tsx',
    ]);
    const files = offenders(UI, /rounded-md(?![\w-])/).map((where) => where.split(':')[0]);
    expect(files.filter((file) => !allowed.has(file ?? ''))).toEqual([]);
  });

  test('the card and table-wrapper idiom uses the token everywhere in src', () => {
    expect(offenders(SRC, /rounded-xl(?![\w-])/)).toEqual([]);
  });
});

describe('ui primitive colours', () => {
  test('no white text on a solid light fill in ui/', () => {
    const bad = UI.filter(
      (line) => line.text.includes(WHITE) && /bg-(emerald|primary|ring|amber|red)-?/.test(line.text)
    );
    expect(bad.map((line) => line.where)).toEqual([]);
    expect(offenders(UI, new RegExp(`bg-emerald-500 ${WHITE}`))).toEqual([]);
  });

  test('warning and success are not Button variants any more', () => {
    expect(offenders(SRC, /variant=["'](warning|success|accent)["']/)).toEqual([]);
    expect(offenders(SRC, /variant=\{[^}]*['"](warning|success|accent)['"]/)).toEqual([]);
  });

  test('Button never hard-codes a fill for danger', () => {
    const button = UI.filter((line) => line.where.startsWith('src/components/ui/Button.tsx'));
    // A resting fill has no variant prefix; `hover:bg-danger/10` is the allowed hover tint.
    expect(offenders(button, /danger:.*(?<![:\w-])bg-(red|danger)/)).toEqual([]);
  });
});

describe('table chrome', () => {
  test('header cells use the eyebrow style, not ad-hoc uppercase tracking', () => {
    expect(offenders(SRC, /<(tr|thead)\b[^>]*uppercase tracking-wider text-faint/)).toEqual([]);
  });

  test('table cells use the 16px / 10px rhythm, not the old 20px / 12px', () => {
    expect(offenders(SRC, /<(th|td)\b[^>]*\bpx-5\b/)).toEqual([]);
  });
});
