/**
 * The rules `docs:check` holds the documents to besides their links:
 *
 * - a shell block in a quickstart is run (`bash test`) or says why it is not (`bash notrun`, with a `> Not run:` quote
 *   under the same heading), so no command is left unchecked without saying so;
 * - a TypeScript block imports only packages that exist (the SDK is `qelay-cloud`, never `@qelay-cloud/sdk`);
 * - every `QCLOUD_*` variable the production code reads is in the configuration reference, and the reference lists no
 *   variable the code no longer reads.
 */
import { readFileSync } from 'node:fs';
import { basename, relative, resolve } from 'node:path';
import { Glob } from 'bun';
import type { Problem } from './links';
import { ROOT } from './links';
import type { MarkdownDoc } from './markdown';

const SHELL = new Set(['bash', 'sh', 'shell', 'console', 'zsh']);
const CODE = new Set(['ts', 'tsx', 'typescript', 'js', 'javascript']);
const FLAGS = new Set(['test', 'notrun']);

export const isQuickstart = (path: string) => basename(path).startsWith('quickstart-');

export function checkFences(docs: readonly MarkdownDoc[], root = ROOT): Problem[] {
  const problems: Problem[] = [];
  for (const doc of docs) {
    const file = relative(root, doc.path);
    const fail = (line: number, message: string) => problems.push({ file, line, message });
    for (const fence of doc.fences) {
      for (const flag of fence.flags) {
        if (!FLAGS.has(flag) || !SHELL.has(fence.lang)) {
          fail(fence.line, `\`${fence.lang} ${flag}\`: the only fence flags are \`test\` and \`notrun\`, and only on \`bash\``);
        }
      }
      if (!isQuickstart(doc.path) || !SHELL.has(fence.lang)) continue;
      if (fence.lang !== 'bash') fail(fence.line, `use \`bash test\` or \`bash notrun\`, not \`${fence.lang}\``);
      else if (!fence.flags.includes('test') && !fence.flags.includes('notrun')) {
        fail(fence.line, 'a command block in a quickstart is `bash test` (run by docs:check) or `bash notrun`');
      } else if (fence.flags.includes('notrun') && fence.notRun === null) {
        fail(fence.line, 'a `bash notrun` block needs a `> Not run: <reason>` line under its heading');
      }
    }
  }
  return problems;
}

/** The package names of the workspace: what an `import` in a document may name. */
export function workspacePackages(root = ROOT): Set<string> {
  const names = new Set<string>();
  for (const path of new Glob('packages/*/package.json').scanSync({ cwd: root, absolute: true })) {
    names.add((JSON.parse(readFileSync(path, 'utf8')) as { name: string }).name);
  }
  return names;
}

const SPECIFIER = /(?:\bfrom\s+|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)(['"])([^'"]+)\1/gmu;

export function checkImports(
  docs: readonly MarkdownDoc[],
  packages: ReadonlySet<string>,
  root = ROOT
): Problem[] {
  const problems: Problem[] = [];
  for (const doc of docs) {
    for (const fence of doc.fences) {
      if (!CODE.has(fence.lang)) continue;
      for (const match of fence.body.matchAll(SPECIFIER)) {
        const specifier = match[2]!;
        const parts = specifier.startsWith('@') ? specifier.split('/') : [specifier];
        const name = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : specifier.split('/')[0]!;
        if (name !== 'qelay-cloud' && !name.startsWith('@qelay-cloud/')) continue;
        const line = fence.line + 1 + fence.body.slice(0, match.index).split('\n').length - 1;
        const file = relative(root, doc.path);
        if (!packages.has(name)) {
          problems.push({ file, line, message: `\`${specifier}\`: no workspace package is named ${name}` });
        } else if (specifier !== name) {
          problems.push({ file, line, message: `\`${specifier}\`: packages export only their entry point` });
        }
      }
    }
  }
  return problems;
}

const VARIABLE = /\bQCLOUD_[A-Z][A-Z0-9_]*[A-Z0-9](?![A-Za-z0-9_])/gu;
export const CONFIG_REFERENCE = 'docs/reference/configuration.md';
/** Where production code lives: tests, scripts and fixtures read their own variables, listed in CONTRIBUTING.md. */
const SOURCE_GLOBS = ['packages/*/src/**/*.ts', 'packages/panel/serve/*.ts'];

export function variablesRead(root = ROOT): Map<string, string> {
  const found = new Map<string, string>();
  for (const pattern of SOURCE_GLOBS) {
    for (const path of new Glob(pattern).scanSync({ cwd: root, absolute: true })) {
      if (path.includes('/node_modules/') || path.includes('/panel/src/')) continue;
      for (const match of readFileSync(path, 'utf8').matchAll(VARIABLE)) {
        if (!found.has(match[0])) found.set(match[0], relative(root, path));
      }
    }
  }
  return found;
}

export function checkVariables(root = ROOT): Problem[] {
  const text = readFileSync(resolve(root, CONFIG_REFERENCE), 'utf8');
  const documented = new Set(text.match(VARIABLE) ?? []);
  const read = variablesRead(root);
  const problems: Problem[] = [];
  for (const [name, where] of [...read].sort()) {
    if (!documented.has(name)) {
      problems.push({ file: CONFIG_REFERENCE, line: 1, message: `${name} (read in ${where}) is not documented` });
    }
  }
  for (const name of [...documented].sort()) {
    if (!read.has(name)) {
      problems.push({ file: CONFIG_REFERENCE, line: 1, message: `${name} is documented and no production code reads it` });
    }
  }
  return problems;
}
