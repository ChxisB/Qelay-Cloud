/**
 * `bun run docs:check` holds the documentation to the code:
 *
 * 1. the generated documents are current (`--write` rewrites them);
 * 2. every relative link and `#fragment` resolves;
 * 3. a shell block in a quickstart is run or says why it is not, a TypeScript block imports packages that exist;
 * 4. the configuration reference lists exactly the `QCLOUD_*` variables the code reads;
 * 5. every `bash test` block runs, in order, against a throwaway database (skipped with `--no-run`, or with a warning
 *    when Postgres is down, unless `QCLOUD_REQUIRE_DB=1`).
 *
 * The first four need nothing running. Exit status is 1 when any check fails.
 */
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { GENERATED } from './docs/generated';
import { checkLinks, documentPaths, ROOT } from './docs/links';
import type { Problem } from './docs/links';
import { readMarkdown } from './docs/markdown';
import { checkFences, checkImports, checkVariables, workspacePackages } from './docs/policy';
import { DOC_PORTS, portsInUse, prepareDatabase, runScript, scriptsOf } from './docs/run';

const args = new Set(process.argv.slice(2));
const unknown = [...args].filter((arg) => !['--write', '--no-run'].includes(arg));
if (unknown.length > 0) {
  console.error(`unknown argument ${unknown.join(', ')}; usage: docs:check [--write] [--no-run]`);
  process.exit(2);
}

const problems: Problem[] = [];
const report = (title: string, found: Problem[], detail: string) => {
  problems.push(...found);
  console.log(`${found.length === 0 ? 'ok  ' : 'FAIL'} ${title}${found.length === 0 ? ` (${detail})` : ''}`);
  for (const problem of found) console.log(`       ${problem.file}:${problem.line}: ${problem.message}`);
};

// 1. Generated documents.
if (args.has('--write')) {
  for (const doc of GENERATED) {
    const path = resolve(ROOT, doc.path);
    mkdirSync(dirname(path), { recursive: true });
    await Bun.write(path, await doc.render());
    console.log(`wrote ${doc.path}`);
  }
}
const stale: Problem[] = [];
for (const doc of GENERATED) {
  const current = await Bun.file(resolve(ROOT, doc.path))
    .text()
    .catch(() => null);
  if (current !== (await doc.render())) {
    stale.push({ file: doc.path, line: 1, message: 'is missing or out of date: run `bun run docs:check --write`' });
  }
}
report('generated documents are current', stale, `${GENERATED.length} documents`);

// 2. Links.
const paths = documentPaths();
const links = checkLinks(paths);
report('links resolve', links.problems, `${links.checked} relative links in ${paths.length} files, ${links.external} external not followed`);

// 3. Fences and imports.
const docs = paths.map(readMarkdown);
report('command blocks say whether they are run', checkFences(docs), `${docs.reduce((n, d) => n + d.fences.length, 0)} blocks`);
report('code blocks import packages that exist', checkImports(docs, workspacePackages()), 'qelay-cloud and @qelay-cloud/*');

// 4. Configuration reference.
report('configuration reference matches the code', checkVariables(), 'every QCLOUD_* variable, both ways');

// 5. The documented commands.
const scripts = scriptsOf(docs);
let ran = 0;
if (args.has('--no-run')) {
  console.log(`skip ${scripts.reduce((n, s) => n + s.blocks.length, 0)} documented command blocks (--no-run)`);
} else if (scripts.length === 0) {
  console.log('ok   no documented command blocks to run');
} else {
  const busy = await portsInUse(DOC_PORTS);
  const prepared = busy.length > 0 ? null : await prepareDatabase();
  if (busy.length > 0) {
    problems.push({ file: 'docs', line: 1, message: `port ${busy.join(', ')} is in use: the quickstarts need it free` });
    console.log(`FAIL port ${busy.join(', ')} is in use: the quickstarts need it free`);
  } else if (prepared !== null && !prepared.ok) {
    const required = process.env.QCLOUD_REQUIRE_DB === '1';
    console.log(`${required ? 'FAIL' : 'skip'} documented commands not run: ${prepared.reason}`);
    if (required) problems.push({ file: 'docs', line: 1, message: prepared.reason });
  } else if (prepared !== null && prepared.ok) {
    try {
      for (const script of scripts) {
        const result = await runScript(script, prepared.databaseUrl);
        ran += script.blocks.length;
        const label = `${script.file}: ${script.blocks.length} blocks in ${result.seconds.toFixed(0)} s`;
        if (result.ok) {
          console.log(`ok   ${label}`);
          continue;
        }
        const at = result.failedAt ?? script.file;
        problems.push({ file: script.file, line: Number(at.split(':').at(-1)) || 1, message: 'a documented command failed' });
        console.log(`FAIL ${label}\n       stopped in the block at ${at}; the last output:`);
        console.log(result.tail.replace(/^/gmu, '       | '));
      }
    } finally {
      await prepared.drop();
    }
  }
}

console.log(
  problems.length === 0 ? `docs:check passed${ran > 0 ? ` (${ran} documented blocks run)` : ''}` : `docs:check found ${problems.length} problem(s)`
);
process.exit(problems.length === 0 ? 0 : 1);
