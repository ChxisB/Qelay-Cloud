/**
 * `bun run docs:transports` writes docs/transports.md; `--check` fails when it is out of date.
 */
import { resolve } from 'node:path';
import { renderTransportsDoc } from './transportsDoc';

const path = resolve(import.meta.dir, '../docs/transports.md');
const rendered = await renderTransportsDoc();

if (process.argv.includes('--check')) {
  const current = await Bun.file(path).text().catch(() => '');
  if (current !== rendered) {
    console.error('docs/transports.md is out of date: run `bun run docs:transports`.');
    process.exit(1);
  }
  console.log('docs/transports.md is up to date.');
} else {
  await Bun.write(path, rendered);
  console.log(`wrote ${path}`);
}
