import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { Glob } from 'bun';
import { WORKFLOW_GLOBS, workflowViolationsIn } from '../../scripts/workflowBoundary';

describe('workflow boundary rule', () => {
  test('SQLite, a socket and the upstream client are refused', () => {
    for (const line of [
      "import { Database } from 'bun:sqlite';",
      "import Database from 'better-sqlite3';",
      "import net from 'node:net';",
      'const socket = await Bun.connect({ hostname, port });',
      "import { Qelay } from '../../client';",
      "import { QelayClient } from 'qelay';",
      "const q = await import('@qelay/client');",
      'const q = new Qelay({ host });',
    ]) {
      expect(workflowViolationsIn('x.ts', line).length).toBeGreaterThan(0);
    }
  });

  test('a doc comment may name them and a name that merely contains one is fine', () => {
    const source = [
      '/** Upstream used `bun:sqlite` and the `Qelay` class; this port uses the store port. */',
      "// import { Qelay } from '../client';",
      "import { Queue } from '../queue';",
      "const note = 'Qelay-shaped';",
      'const QelayLike = 1;',
    ].join('\n');
    expect(workflowViolationsIn('x.ts', source)).toEqual([]);
  });

  test('no workflow file reaches past the store port and the SDK queue', async () => {
    const root = resolve(import.meta.dir, '../..');
    const found = [];
    let checked = 0;
    for (const pattern of WORKFLOW_GLOBS) {
      for await (const file of new Glob(pattern).scan({ cwd: root })) {
        checked += 1;
        found.push(...workflowViolationsIn(file, await Bun.file(resolve(root, file)).text()));
      }
    }
    expect(checked).toBeGreaterThan(30);
    expect(found).toEqual([]);
  });
});
