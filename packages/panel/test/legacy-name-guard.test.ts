import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dir, '..');

// The old product name (`bq-dash` and its long form) and the upstream author's handle may
// only survive where they are deliberate: migrating a user's old data, ignoring old build
// output, or crediting the project this one was forked from. A new occurrence anywhere else in
// code or config fails here. Prose (README, CHANGELOG, docs pages) is not scanned: it names the
// upstream project on purpose and is reviewed by hand.
// The long form is spelled in two parts so that a search for the old name finds only real uses.
const OLD_NAME = new RegExp(['bun' + 'queue.?dashboard', 'bq-dash', 'egeominotti'].join('|'), 'gi');

// The clone carries the browser app, its e2e specs and its static assets. The upstream agent,
// scripts, docker and docs trees are not part of it (docs/PORTING.md), so they are not scanned.
const SCANNED_DIRS = ['e2e', 'public'];
const SCANNED_FILES = [
  '.gitignore',
  'index.html',
  'package.json',
  'playwright.config.ts',
  'vite.config.ts',
];
const SKIPPED_DIRS = new Set(['node_modules', 'dist', 'cache']);
const TEXT = /\.(ts|tsx|js|mjs|json|html|css|svg|yml|yaml|md|txt|webmanifest)$/;

const ALLOWED: Record<string, number> = {
  // The pre-paint theme script falls back to the old theme key (src/lib/legacyStorage.ts).
  'index.html': 1,
};

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return SKIPPED_DIRS.has(entry.name) ? [] : walk(path);
    return TEXT.test(entry.name) || !entry.name.includes('.') ? [path] : [];
  });
}

function scan(): Record<string, number> {
  const files = [
    ...SCANNED_DIRS.flatMap((dir) => walk(join(ROOT, dir))),
    ...SCANNED_FILES.map((file) => join(ROOT, file)).filter(
      (path) => existsSync(path) && statSync(path).isFile()
    ),
  ];
  const found: Record<string, number> = {};
  for (const file of files) {
    const hits = readFileSync(file, 'utf8').match(OLD_NAME)?.length ?? 0;
    if (hits) found[relative(ROOT, file)] = hits;
  }
  return found;
}

describe('legacy name guard', () => {
  test('the old name only survives at the allowed code and config sites', () => {
    expect(scan()).toEqual(ALLOWED);
  });

  test('the upstream copyright notice stays in the license, verbatim', () => {
    // The MIT license requires the original notice in all copies.
    expect(readFileSync(join(ROOT, 'LICENSE'), 'utf8')).toContain(
      'Copyright (c) 2026 Egeo Minotti'
    );
  });

  test('the license names the fork holder next to the upstream notice, with no placeholder left', () => {
    const lines = readFileSync(join(ROOT, 'LICENSE'), 'utf8').split('\n');
    const notices = lines.filter((line) => line.startsWith('Copyright (c)'));
    expect(notices).toEqual(['Copyright (c) 2026 Egeo Minotti', 'Copyright (c) 2026 ChxisB']);
  });
});
