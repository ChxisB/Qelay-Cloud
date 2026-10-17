import { readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Task 73: the version bump, prepared and not run. `bun scripts/release-bump.ts 1.0.0 --repository=<url>` prints what
 * it would change in every packages/*\/package.json; `--apply` writes it. Nothing else is touched: no tag, no commit, no publish.
 *
 * The panel is an app (an image and static files), so it gets the version and stays `private`. Every other package is
 * published: no longer private, public on npm, with provenance (which npm only issues from a supported CI runner).
 */
type Json = Record<string, unknown>;

export function bumped(pkg: Json, version: string, repository: string, dir: string): Json {
  const next: Json = { ...pkg, version };
  if (pkg.name === '@qelay-cloud/panel') return next;
  delete next.private;
  return {
    ...next,
    repository: { type: 'git', url: `git+${repository}.git`, directory: `packages/${dir}` },
    homepage: repository,
    bugs: { url: `${repository}/issues` },
    publishConfig: { access: 'public', provenance: true },
  };
}

if (import.meta.main) {
  const version = process.argv[2] ?? '';
  const repository = process.argv.find((arg) => arg.startsWith('--repository='))?.slice('--repository='.length) ?? '';
  if (!/^\d+\.\d+\.\d+$/.test(version) || !/^https:\/\/\S+[^/\s]$/.test(repository)) {
    console.error('usage: bun scripts/release-bump.ts <x.y.z> --repository=https://host/owner/repo [--apply]');
    process.exit(2);
  }
  const root = join(import.meta.dir, '../packages');
  for (const dir of readdirSync(root)) {
    const file = join(root, dir, 'package.json');
    const before = (await Bun.file(file).json()) as Json;
    const after = bumped(before, version, repository, dir);
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    const changes = [...keys].filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]));
    console.log(`${String(before.name)}: ${changes.join(', ')}`);
    if (process.argv.includes('--apply')) await Bun.write(file, `${JSON.stringify(after, null, 2)}\n`);
  }
  if (!process.argv.includes('--apply')) console.log('dry run: nothing written (add --apply)');
}
