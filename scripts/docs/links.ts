/**
 * The link check of `docs:check`: every relative link of a document names a file or folder that exists, and a
 * `#fragment` names a heading of the Markdown file it points into. Links to other sites are counted and not
 * followed: the check runs offline, and a site that is down must not fail a build.
 */
import { Glob } from 'bun';
import { existsSync, statSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import type { MarkdownDoc } from './markdown';
import { readMarkdown } from './markdown';

export interface Problem {
  readonly file: string;
  readonly line: number;
  readonly message: string;
}

export const ROOT = resolve(import.meta.dir, '../..');

const GLOBS = [
  'README.md',
  'CONTRIBUTING.md',
  'DESIGN.md',
  'docs/**/*.md',
  'infra/**/*.md',
  'packages/*/README.md',
  'examples/**/*.md',
];

/** The documents the checks read, as absolute paths. `CLAUDE.md` and `.claude/` are instructions for the agent, not documentation. */
export function documentPaths(root = ROOT): string[] {
  const found = new Set<string>();
  for (const pattern of GLOBS) {
    for (const path of new Glob(pattern).scanSync({ cwd: root, absolute: true })) {
      if (!path.includes(`${sep}node_modules${sep}`)) found.add(path);
    }
  }
  return [...found].sort();
}

const EXTERNAL = /^[a-z][a-z0-9+.-]*:/iu;

export interface LinkReport {
  readonly problems: Problem[];
  readonly checked: number;
  readonly external: number;
}

export function checkLinks(paths: readonly string[], root = ROOT): LinkReport {
  const cache = new Map<string, MarkdownDoc>();
  const read = (path: string): MarkdownDoc => {
    let doc = cache.get(path);
    if (doc === undefined) {
      doc = readMarkdown(path);
      cache.set(path, doc);
    }
    return doc;
  };
  const problems: Problem[] = [];
  let checked = 0;
  let external = 0;

  for (const path of paths) {
    const doc = read(path);
    const file = relative(root, path);
    const fail = (line: number, message: string) => problems.push({ file, line, message });
    for (const link of doc.links) {
      if (EXTERNAL.test(link.target)) {
        external += 1;
        continue;
      }
      checked += 1;
      const [rawPath = '', fragment] = link.target.split('#') as [string, string | undefined];
      if (rawPath.startsWith('/')) {
        fail(link.line, `${link.target}: an absolute path; links are relative to the file`);
        continue;
      }
      let decoded: string;
      try {
        decoded = decodeURIComponent(rawPath);
      } catch {
        fail(link.line, `${link.target}: not a valid link`);
        continue;
      }
      const target = decoded === '' ? path : resolve(dirname(path), decoded);
      const inside = relative(root, target);
      if (inside.startsWith('..')) {
        fail(link.line, `${link.target}: points outside the documentation (${inside || '.'})`);
        continue;
      }
      if (!existsSync(target)) {
        fail(link.line, `${link.target}: no such file or folder`);
        continue;
      }
      if (fragment === undefined || fragment === '') continue;
      if (!target.endsWith('.md') || !statSync(target).isFile()) continue;
      if (!read(target).anchors.has(decodeURIComponent(fragment))) {
        fail(link.line, `${link.target}: ${relative(root, target)} has no heading #${fragment}`);
      }
    }
  }
  return { problems, checked, external };
}
