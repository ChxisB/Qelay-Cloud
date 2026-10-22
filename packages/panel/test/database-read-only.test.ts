import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..', 'src');

describe('Database page is read only', () => {
  test('the client has no write route: only reads and the read-only query', () => {
    const source = readFileSync(join(root, 'lib', 'bq', 'agentApi.ts'), 'utf8');
    const database = source.slice(
      source.indexOf('export const dbApi'),
      source.indexOf('export const controlApi')
    );
    expect(database).toContain("'/db/query'");
    expect(database).not.toMatch(/'(PUT|PATCH|DELETE)'/);
    expect(database.match(/'POST'/g)).toHaveLength(1);
  });

  test('the page draws no control that edits a row, a table or the file', () => {
    const dir = join(root, 'pages', 'control', 'database');
    const text = readdirSync(dir)
      .filter((name) => name.endsWith('.tsx'))
      .map((name) => readFileSync(join(dir, name), 'utf8'))
      .join('\n');
    expect(text).not.toMatch(/method: '(PUT|PATCH|DELETE)'/);
    expect(text).not.toMatch(/>\s*(Insert|Delete|Drop|Save row|Edit row|Add row|Truncate)\b/);
  });
});
