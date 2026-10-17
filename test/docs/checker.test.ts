import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkLinks } from '../../scripts/docs/links';
import { parseMarkdown, slugOf } from '../../scripts/docs/markdown';
import { checkFences, checkImports, checkVariables } from '../../scripts/docs/policy';
import { runScript, scriptsOf } from '../../scripts/docs/run';

/**
 * `docs:check` is only worth running if it fails when it should. These tests feed it documents that are wrong in the
 * ways a real one drifts (a dead link, a dead anchor, an unchecked command, a renamed package, an undocumented variable,
 * a command that fails) and expect it to say so, and a good document and expect it to stay quiet.
 */
const root = mkdtempSync(join(tmpdir(), 'qcloud-docscheck-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function write(path: string, text: string): string {
  const full = join(root, path);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, text);
  return full;
}

const parse = (path: string, text: string) => parseMarkdown(write(path, text), text);

describe('markdown reader', () => {
  test('anchors follow GitHub: punctuation dropped, code unwrapped, repeats numbered', () => {
    expect(slugOf('The `Queue` API: add() & co.')).toBe('the-queue-api-add--co');
    const doc = parseMarkdown('x.md', '# Same\n\n## Same\n');
    expect([...doc.anchors]).toEqual(['same', 'same-1']);
  });

  test('links inside code spans and fences are not links', () => {
    const doc = parseMarkdown(
      'x.md',
      'See `[a](nowhere.md)` and [b](real.md).\n\n```md\n[c](also-nowhere.md)\n```\n'
    );
    expect(doc.links.map((link) => link.target)).toEqual(['real.md']);
  });
});

describe('link check', () => {
  test('a good document passes', () => {
    const a = write('docs/a.md', '# A\n\n[b](b.md#there) [self](#a) [site](https://example.com)\n');
    const b = write('docs/b.md', '## There\n');
    const report = checkLinks([a, b], root);
    expect(report.problems).toEqual([]);
    expect(report.checked).toBe(2);
    expect(report.external).toBe(1);
  });

  test('a missing file, a missing heading, an absolute path and a path out of the tree are each reported', () => {
    const a = write(
      'docs/bad.md',
      [
        '[gone](gone.md)',
        '[anchor](b.md#nope)',
        '[abs](/etc/passwd)',
        '[out](../../outside.md)',
        '[self](#nope)',
      ].join('\n')
    );
    write('docs/b.md', '## There\n');
    const messages = checkLinks([a], root).problems.map((problem) => problem.message);
    expect(messages).toHaveLength(5);
    expect(messages[0]).toContain('no such file');
    expect(messages[1]).toContain('has no heading #nope');
    expect(messages[2]).toContain('absolute path');
    expect(messages[3]).toContain('outside the documentation');
    expect(messages[4]).toContain('has no heading #nope');
  });
});

describe('fence policy', () => {
  const quickstart = (body: string) => parse('docs/quickstart-x.md', `# Q\n\n${body}\n`);

  test('a quickstart command must be run or say why not', () => {
    const doc = quickstart(
      '```bash\nls\n```\n\n```sh test\nls\n```\n\n```bash notrun\nls\n```\n\n```bash test\nls\n```'
    );
    const problems = checkFences([doc], root);
    expect(problems.map((problem) => problem.line)).toEqual([3, 7, 11]);
    expect(problems[2]!.message).toContain('Not run');
  });

  test('a notrun block with its reason, and a test block, pass', () => {
    const doc = quickstart(
      '> Not run: it deletes things.\n\n```bash notrun\nrm x\n```\n\n```bash test\nls\n```'
    );
    expect(checkFences([doc], root)).toEqual([]);
  });

  test('a flag other than test and notrun is refused anywhere', () => {
    const doc = parse('docs/other.md', '```bash skip\nls\n```\n```ts test\n1\n```\n');
    expect(checkFences([doc], root)).toHaveLength(2);
  });
});

describe('import check', () => {
  const packages = new Set(['qelay-cloud', '@qelay-cloud/core']);

  test('a package that does not exist and a deep import are reported; a real one is not', () => {
    const doc = parse(
      'docs/imports.md',
      "```ts\nimport { Queue } from 'qelay-cloud';\nimport { A } from '@qelay-cloud/sdk';\nimport { B } from '@qelay-cloud/core/src/x';\nimport fs from 'node:fs';\n```\n"
    );
    const problems = checkImports([doc], packages, root);
    expect(problems.map((problem) => problem.line)).toEqual([3, 4]);
    expect(problems[0]!.message).toContain('no workspace package');
    expect(problems[1]!.message).toContain('only their entry point');
  });
});

describe('variable reference', () => {
  test('an undocumented variable and a stale one are both reported', () => {
    write(
      'packages/core/src/env.ts',
      'export const a = process.env.QCLOUD_READ_ME;\nexport const b = process.env.QCLOUD_BOTH;\n'
    );
    write('docs/reference/configuration.md', '`QCLOUD_BOTH` and `QCLOUD_LONG_GONE`\n');
    const messages = checkVariables(root).map((problem) => problem.message);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toContain('QCLOUD_READ_ME');
    expect(messages[0]).toContain('is not documented');
    expect(messages[1]).toContain('QCLOUD_LONG_GONE');
  });
});

describe('command runner', () => {
  const scripts = (code: string) =>
    scriptsOf(
      [parse('docs/quickstart-run.md', `# Run\n\n\`\`\`bash test\n${code}\n\`\`\`\n`)],
      root
    );

  test('blocks run in order in one shell, so a later block sees an earlier one', async () => {
    const [script] = scripts('export WHO=docs\necho "hello $WHO $QCLOUD_DATABASE_URL"');
    const result = await runScript(script!, 'postgres://example/db', 30_000);
    expect(result.ok).toBe(true);
    expect(result.tail).toContain('hello docs postgres://example/db');
  });

  test('a failing command fails the run and names the block', async () => {
    const [script] = scripts('echo before\nfalse\necho after');
    const result = await runScript(script!, 'postgres://example/db', 30_000);
    expect(result.ok).toBe(false);
    expect(result.failedAt).toBe('docs/quickstart-run.md:3');
    expect(result.tail).toContain('before');
    expect(result.tail).not.toContain('after');
  });

  test('the developer environment does not reach a block', async () => {
    process.env.QCLOUD_DOCS_TEST_SECRET = 'leak';
    const [script] = scripts('[ -z "${QCLOUD_DOCS_TEST_SECRET:-}" ]');
    expect((await runScript(script!, 'postgres://example/db', 30_000)).ok).toBe(true);
    delete process.env.QCLOUD_DOCS_TEST_SECRET;
  });
});
