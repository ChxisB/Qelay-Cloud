/**
 * Mechanical port step of the task 01 spike, kept for upstream syncs.
 *
 * Reads Qelay's Postgres hot path at a fixed commit (read-only `git show`, never a checkout),
 * follows its relative imports, and writes every file it reaches under `--out` with the
 * same layout as upstream `src/`. The only change is the rename to the `qcloud` prefix.
 *
 *   bun scripts/port.ts --out <dir> [--upstream ../qelay]
 *
 * The output is then run through `oxlint --fix` and `oxfmt` (house style). Everything after that
 * is a hand edit (task 01 counted them with a `measure.ts` that the Phase 0 gate deleted).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';

export const UPSTREAM_COMMIT = 'c43442c9';

/** Hot-path entry points. Everything they import, transitively, is ported. */
export const HOT_PATH_ENTRIES = [
  'admission',
  'claims',
  'leaseRenewal',
  'leaseRelease',
  'completionOutcome',
  'outcomes',
  'recovery',
  'dlqLifecycle',
  'expiry',
  'schemaInitialization',
].map((name) => `src/infrastructure/persistence/postgres/${name}.ts`);

/** The only mechanical rewrite: table, lock, channel and symbol prefixes. */
export function renamePrefix(source: string): string {
  return source.replaceAll('bunqueue', 'qcloud');
}

export function showUpstream(upstream: string, path: string): string | undefined {
  const result = Bun.spawnSync(['git', '-C', upstream, 'show', `${UPSTREAM_COMMIT}:${path}`]);
  return result.exitCode === 0 ? result.stdout.toString() : undefined;
}

function resolveImport(upstream: string, from: string, specifier: string): string | undefined {
  const base = normalize(join(dirname(from), specifier));
  for (const candidate of [`${base}.ts`, `${base}/index.ts`]) {
    if (showUpstream(upstream, candidate) !== undefined) return candidate;
  }
  return undefined;
}

/** Upstream paths reachable from the entries through relative imports, sorted. */
export function hotPathClosure(upstream: string): string[] {
  const seen = new Set<string>();
  const pending = [...HOT_PATH_ENTRIES];
  while (pending.length > 0) {
    const path = pending.pop();
    if (path === undefined || seen.has(path)) continue;
    const source = showUpstream(upstream, path);
    if (source === undefined) throw new Error(`Missing upstream file ${path}`);
    seen.add(path);
    for (const match of source.matchAll(/from '(\.[^']+)'/g)) {
      const target = resolveImport(upstream, path, match[1] ?? '');
      if (target !== undefined && !seen.has(target)) pending.push(target);
    }
  }
  return [...seen].sort();
}

/** `src/domain/x.ts` -> `<out>/domain/x.ts`. */
export function portedPath(out: string, upstreamPath: string): string {
  return join(out, upstreamPath.replace(/^src\//, ''));
}

function argument(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}

if (import.meta.main) {
  const upstream = argument('--upstream', '../qelay');
  const out = argument('--out', '');
  if (out === '') throw new Error('usage: bun scripts/port.ts --out <dir> [--upstream ../qelay]');
  const files = hotPathClosure(upstream);
  for (const path of files) {
    const target = portedPath(out, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, renamePrefix(showUpstream(upstream, path) ?? ''));
  }
  console.log(`Ported ${files.length} files from ${upstream}@${UPSTREAM_COMMIT} to ${out}`);
}
