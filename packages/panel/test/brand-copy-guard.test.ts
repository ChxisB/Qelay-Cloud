import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const SRC = join(ROOT, 'src');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

function count(pattern: RegExp): Record<string, number> {
  const found: Record<string, number> = {};
  for (const file of sourceFiles(SRC)) {
    const hits = readFileSync(file, 'utf8').match(pattern)?.length ?? 0;
    if (hits) found[relative(ROOT, file)] = hits;
  }
  return found;
}

/**
 * The old product name (`bq-dash` and its long form) may only remain at the
 * sites a later rebrand task owns. Each task shrinks this list; a new occurrence
 * anywhere else fails here instead of shipping.
 *
 * 09 persisted identifiers: only `lib/legacyStorage.ts` keeps the old storage keys, to migrate them
 * 10 package/runtime naming: install command, placeholder URL origin (done)
 * 11 HTML metadata and docs URL (done: the three docs links point at the derived Pages URL)
 */
const DEFERRED: Record<string, number> = {
  // 09: the migration module owns the old storage keys
  'src/lib/legacyStorage.ts': 6,
};

describe('brand copy guard', () => {
  test('the old product name only survives at deferred sites', () => {
    expect(count(new RegExp('bun' + 'queue.?dash|bq.?dash', 'gi'))).toEqual(DEFERRED);
  });

  test('no title-case theme labels', () => {
    expect(count(/Light Mode|Dark Mode/g)).toEqual({});
  });

  test('the footer repo link points at the fork, not upstream', () => {
    const footer = readFileSync(join(SRC, 'components/layout/SidebarFooter.tsx'), 'utf8');
    expect(footer).toContain("'https://github.com/ChxisB/qelay-control-panel'");
    expect(footer).not.toContain('github.com/egeominotti');
  });

  test('the assistant introduces itself as the Qelay assistant', () => {
    const runtime = readFileSync(join(SRC, 'lib/copilot/runtime.ts'), 'utf8');
    expect(runtime).toContain('You are the Qelay assistant');
    // It still describes the server it drives accurately.
    expect(runtime).toContain('embedded in Qelay Cloud');
    expect(runtime).toContain('operates a Qelay-compatible job queue');
  });
});
