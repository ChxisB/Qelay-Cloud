import { Glob } from 'bun';
import { resolve } from 'node:path';
import { INGEST_ROOT, ingestViolationsIn } from './ingestBoundary';

const ROOT = resolve(import.meta.dir, '..');
const violations = [];
let checked = 0;
for await (const file of new Glob('**/*.ts').scan({ cwd: resolve(ROOT, INGEST_ROOT) })) {
  checked += 1;
  const path = `${INGEST_ROOT}/${file}`;
  violations.push(...ingestViolationsIn(path, await Bun.file(resolve(ROOT, path)).text()));
}

if (violations.length > 0) {
  console.error('The ingest reaches past the store and core, where it could call out:');
  for (const v of violations) console.error(`- ${v.file}:${v.line} ${v.rule}: ${v.text}`);
  process.exit(1);
}
if (checked === 0) {
  console.error('The ingest boundary check found no files; its root is wrong.');
  process.exit(1);
}
console.log(`${checked} ingest files import only core, the store, Node and Bun.`);
