import { describe, expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { bumped } from '../../scripts/release-bump';
import { groupByText, shippedKeys, type Lock } from '../../scripts/third-party-notices';

/** Task 73: what the release preparation promises, held where a later change would break it. */
const root = join(import.meta.dir, '../..');
const packages = readdirSync(join(root, 'packages')).map((dir) => join(root, 'packages', dir));

describe('package metadata', () => {
  test('every package is MIT, needs Bun 1.4.2 or later, and carries a licence file; the published ones list only src', async () => {
    const mit = await Bun.file(join(root, 'LICENSE')).text();
    for (const dir of packages) {
      const pkg = (await Bun.file(join(dir, 'package.json')).json()) as Record<string, unknown>;
      expect([pkg.name, pkg.license, pkg.engines]).toEqual([pkg.name, 'MIT', { bun: '>=1.4.2' }]);
      const licence = await Bun.file(join(dir, 'LICENSE')).text();
      // The panel keeps the licence of the panel it was copied from, which already names both holders.
      expect([pkg.name, licence.includes('Copyright (c) 2026 ChxisB')]).toEqual([pkg.name, true]);
      if (pkg.name !== '@qelay-cloud/panel') {
        expect([pkg.name, licence, pkg.files]).toEqual([pkg.name, mit, ['src', 'LICENSE']]);
      }
    }
  });

  test('nothing is published, versioned or un-privated until the bump is applied', async () => {
    for (const dir of packages) {
      const pkg = (await Bun.file(join(dir, 'package.json')).json()) as Record<string, unknown>;
      expect([pkg.name, pkg.private, pkg.version]).toEqual([pkg.name, true, '0.0.0']);
    }
  });

  test('the prepared bump publishes every package but the panel, which only gets the version', () => {
    const lib = bumped(
      { name: 'qelay-cloud', version: '0.0.0', private: true },
      '1.0.0',
      'https://example.test/o/r',
      'sdk'
    );
    expect(lib).toMatchObject({
      version: '1.0.0',
      homepage: 'https://example.test/o/r',
      repository: { directory: 'packages/sdk' },
      publishConfig: { access: 'public', provenance: true },
    });
    expect('private' in lib).toBe(false);
    expect(
      bumped(
        { name: '@qelay-cloud/panel', version: '0.0.0', private: true },
        '1.0.0',
        'https://example.test/o/r',
        'panel'
      )
    ).toEqual({
      name: '@qelay-cloud/panel',
      version: '1.0.0',
      private: true,
    });
  });
});

describe('third-party notices', () => {
  const entry = (id: string, deps: Record<string, string> = {}): Lock['packages'][string] => [
    id,
    '',
    { dependencies: deps },
  ];
  const lock: Lock = {
    workspaces: {
      '': { dependencies: { tooling: '1' } },
      'packages/a': { dependencies: { used: '1', alone: '1' } },
    },
    packages: {
      used: entry('used@1.0.0', { shared: '^1' }),
      'used/shared': entry('shared@1.5.0'),
      shared: entry('shared@2.0.0'),
      alone: entry('alone@1.0.0'),
      tooling: entry('tooling@1.0.0', { shared: '^2' }),
      other: entry('other@1.0.0', { shared: '^2' }),
    },
  };

  test('a package ships when a workspace needs it, a nested copy beats the hoisted one, and the root workspace does not count', () => {
    expect([...shippedKeys(lock)].sort()).toEqual(['alone', 'used', 'used/shared']);
  });

  test('packages with the same licence text share one copy of it', () => {
    const rows = [
      { id: 'b@1', licence: 'MIT', text: 'x' },
      { id: 'a@1', licence: 'MIT', text: 'x' },
      { id: 'c@1', licence: 'ISC', text: 'y' },
    ];
    expect(groupByText(rows)).toEqual([
      { text: 'x', licences: ['MIT'], ids: ['a@1', 'b@1'] },
      { text: 'y', licences: ['ISC'], ids: ['c@1'] },
    ]);
  });
});
