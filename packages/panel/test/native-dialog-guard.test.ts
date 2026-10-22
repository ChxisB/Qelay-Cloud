import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

// The page asks in its own dialog (`confirmInPage`), never in the browser's system box (S2, approved 2026-10-22).
// A page that needs an answer imports the store; a test that needs one uses `answerConfirms`.

const ROOT = join(import.meta.dir, '..');

function sources(dir: string): string[] {
  return readdirSync(join(ROOT, dir), { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name))
    .filter((file) => file !== import.meta.path);
}

/** A use of the browser's confirm, prompt or alert: `window.` or `globalThis.` in front, or a bare call with a message. */
const WINDOW_USE = /\b(window|globalThis)\.(confirm|prompt|alert)\b/;
// shortcut: a bare call whose message is not a literal is not caught (the page has local helpers called `confirm` and
// `alert` that take numbers); upgrade if one ever appears, with a lint rule on the global instead.
const BARE_CALL = /(?<![\w$.])(confirm|prompt|alert)\s*\(\s*['"`]/;

const isComment = (text: string) => /^\s*(\/\/|\/?\*)/.test(text);
const hit = (text: string, patterns: RegExp[]) =>
  !isComment(text) && patterns.some((pattern) => pattern.test(text));

const uses = (files: string[], patterns: RegExp[]) =>
  files.flatMap((file) =>
    readFileSync(file, 'utf8')
      .split('\n')
      .flatMap((text, i) => (hit(text, patterns) ? [`${relative(ROOT, file)}:${i + 1}`] : []))
  );

describe('native dialogs', () => {
  test('nothing in src opens the browser confirm, prompt or alert', () => {
    expect(uses(sources('src'), [WINDOW_USE, BARE_CALL])).toEqual([]);
  });

  test('no test stubs or saves them either, now that nothing calls them', () => {
    expect(uses(sources('test'), [WINDOW_USE])).toEqual([]);
  });

  test('the rule catches each form and passes the page confirm and a comment', () => {
    const both = [WINDOW_USE, BARE_CALL];
    expect(hit('if (window.confirm("Sure?")) go();', both)).toBe(true);
    expect(hit('const ok = globalThis.prompt("Type it");', both)).toBe(true);
    expect(hit('  alert("done");', both)).toBe(true);
    expect(hit('if (confirm("Sure?")) go();', both)).toBe(true);
    expect(hit('const ok = await confirmInPage({ question: "Sure?" });', both)).toBe(false);
    expect(hit('onConfirm("x");', both)).toBe(false);
    expect(hit('{alert(2)}', both)).toBe(false);
    expect(hit('confirm(targets.length)', both)).toBe(false);
    expect(hit(' * replaces window.confirm in the page', both)).toBe(false);
  });
});
