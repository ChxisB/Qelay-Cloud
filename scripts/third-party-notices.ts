import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Task 73: THIRD_PARTY_NOTICES.md, written from bun.lock and the licence files of the installed packages.
 * `--write` rewrites the file, `--check` fails when it is stale, no flag prints it.
 *
 * "Shipped" is every package reachable from a workspace's `dependencies` (the panel's are bundled into its static
 * files); the rest is tooling that is not distributed. The lock lists optional native builds for every platform, but
 * only this platform's are installed, so the others cannot be read here and are listed apart.
 */
type Meta = { dependencies?: Record<string, string>; optionalDependencies?: Record<string, string>; peerDependencies?: Record<string, string> };
type Entry = [string, string, Meta?, string?];
export type Lock = {
  workspaces: Record<string, { dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> }>;
  packages: Record<string, Entry>;
};
type Row = { id: string; licence: string; text: string };

/** The lock keys (not names) of every package a workspace needs to run; a nested key beats a hoisted one. */
export function shippedKeys(lock: Lock): Set<string> {
  const keys = Object.keys(lock.packages);
  const resolve = (from: string, name: string): string | undefined => {
    const scopes = keys.filter((key) => from.startsWith(`${key}/`)).sort((a, b) => b.length - a.length);
    for (const scope of [from, ...scopes]) if (lock.packages[`${scope}/${name}`]) return `${scope}/${name}`;
    return lock.packages[name] ? name : undefined;
  };
  const seen = new Set<string>();
  const visit = (key: string | undefined) => {
    if (key === undefined || seen.has(key)) return;
    seen.add(key);
    const meta = lock.packages[key]?.[2] ?? {};
    for (const group of [meta.dependencies, meta.optionalDependencies, meta.peerDependencies])
      for (const name of Object.keys(group ?? {})) visit(resolve(key, name));
  };
  for (const [path, workspace] of Object.entries(lock.workspaces)) {
    if (path === '') continue;
    for (const group of [workspace.dependencies, workspace.optionalDependencies])
      for (const name of Object.keys(group ?? {})) visit(lock.packages[name] ? name : undefined);
  }
  return seen;
}

/** Groups packages that carry the same licence text, so Apache-2.0 appears once for the whole AWS SDK. */
export function groupByText(rows: readonly Row[]): { text: string; licences: string[]; ids: string[] }[] {
  const groups = new Map<string, { text: string; licences: Set<string>; ids: string[] }>();
  for (const row of rows) {
    const group = groups.get(row.text) ?? { text: row.text, licences: new Set(), ids: [] };
    group.licences.add(row.licence);
    group.ids.push(row.id);
    groups.set(row.text, group);
  }
  return [...groups.values()]
    .map((g) => ({ text: g.text, licences: [...g.licences].sort(), ids: g.ids.sort(byName) }))
    .sort((a, b) => b.ids.length - a.ids.length || a.text.localeCompare(b.text));
}

const byName = (a: string, b: string) => a.localeCompare(b);
const NOTICE_FILE = /^(licen[cs]e|copying|notice)/i;

function licenceOf(json: Record<string, unknown>): string {
  const one = (value: unknown) => (typeof value === 'object' && value ? String((value as { type?: unknown }).type) : String(value));
  if (json.license !== undefined) return one(json.license);
  if (Array.isArray(json.licenses)) return json.licenses.map(one).join(' OR ');
  return 'unknown';
}

/** `name@version` to the folder bun installed it in. Symlinks are the package's own dependencies, not copies. */
function installed(root: string): Map<string, string> {
  const found = new Map<string, string>();
  const store = join(root, 'node_modules/.bun');
  for (const folder of readdirSync(store)) {
    const modules = join(store, folder, 'node_modules');
    let names: string[];
    try {
      names = readdirSync(modules);
    } catch {
      continue;
    }
    for (const name of names) {
      const dirs = name.startsWith('@') ? readdirSync(join(modules, name)).map((n) => `${name}/${n}`) : [name];
      for (const dir of dirs) {
        const path = join(modules, dir);
        if (lstatSync(path).isSymbolicLink()) continue;
        try {
          const json = JSON.parse(readFileSync(join(path, 'package.json'), 'utf8')) as { name: string; version: string };
          found.set(`${json.name}@${json.version}`, path);
        } catch {
          // not a package folder
        }
      }
    }
  }
  return found;
}

function read(path: string): Row['text'] {
  const files = readdirSync(path).filter((file) => NOTICE_FILE.test(file) && lstatSync(join(path, file)).isFile());
  return files
    .sort(byName)
    .map((file) => readFileSync(join(path, file), 'utf8').replaceAll('\r\n', '\n').trim())
    .join('\n\n---\n\n');
}

export function collect(root: string): { shipped: Row[]; tooling: Row[]; absent: string[]; shippedAbsent: string[] } {
  const lock = Bun.JSONC.parse(readFileSync(join(root, 'bun.lock'), 'utf8')) as Lock;
  const shipped = shippedKeys(lock);
  const folders = installed(root);
  const out = { shipped: [] as Row[], tooling: [] as Row[], absent: [] as string[], shippedAbsent: [] as string[] };
  for (const [key, entry] of Object.entries(lock.packages)) {
    const id = entry[0];
    if (id.includes('@workspace:')) continue;
    const path = folders.get(id);
    if (path === undefined) {
      out.absent.push(id);
      if (shipped.has(key)) out.shippedAbsent.push(id);
      continue;
    }
    const json = JSON.parse(readFileSync(join(path, 'package.json'), 'utf8')) as Record<string, unknown>;
    (shipped.has(key) ? out.shipped : out.tooling).push({ id, licence: licenceOf(json), text: read(path) });
  }
  return out;
}

export function render(root: string = join(import.meta.dir, '..')): string {
  const { shipped, tooling, absent, shippedAbsent } = collect(root);
  const lines = [
    '<!-- Generated by `bun run notices --write` from bun.lock and the installed packages. Do not edit. -->',
    '# Third-party notices',
    '',
    'Qelay-Cloud is MIT-licensed ([LICENSE](LICENSE)). The packages below are what it runs on or is built with. Each',
    "package's own licence files are the authority; their text is reproduced here for the ones that ship in a container",
    "image or in the panel's static files.",
    '',
    `${shipped.length} packages ship, ${tooling.length} are build, test and lint tooling that is not distributed, and ${absent.length} lock entries (optional native builds for other platforms) were not installed where this file was generated and cannot be read.`,
    '',
    '## Shipped',
    '',
  ];
  for (const [index, group] of groupByText(shipped.filter((row) => row.text !== '')).entries()) {
    lines.push(`### ${index + 1}. ${group.licences.join(', ')} (${group.ids.length})`, '', group.ids.join(', '), '', '~~~~text', group.text, '~~~~', '');
  }
  const silent = shipped.filter((row) => row.text === '');
  if (silent.length > 0)
    lines.push('### Shipped packages with no licence file', '', ...silent.map((row) => `- ${row.id}: ${row.licence}`), '');
  if (shippedAbsent.length > 0)
    lines.push('### Shipped but not installed here (licence not read)', '', ...shippedAbsent.sort(byName).map((id) => `- ${id}`), '');
  lines.push('## Tooling that is not distributed', '', '| Package | Licence |', '| --- | --- |');
  lines.push(...tooling.sort((a, b) => byName(a.id, b.id)).map((row) => `| ${row.id} | ${row.licence.replaceAll('|', '/')} |`), '');
  return lines.join('\n');
}

if (import.meta.main) {
  const file = join(import.meta.dir, '../THIRD_PARTY_NOTICES.md');
  const text = render();
  if (process.argv.includes('--write')) await Bun.write(file, text);
  else if (process.argv.includes('--check')) {
    if ((await Bun.file(file).text().catch(() => '')) !== text) {
      console.error('THIRD_PARTY_NOTICES.md is stale: run `bun run notices --write`');
      process.exit(1);
    }
  } else console.log(text);
}
