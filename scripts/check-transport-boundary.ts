import { Glob } from 'bun';
import { relative, resolve } from 'node:path';
import { GUARDED_ROOTS, violationsIn } from './transportBoundary';

const ROOT = resolve(import.meta.dir, '..');
const violations = [];
let checked = 0;
for (const guarded of GUARDED_ROOTS) {
  for await (const path of new Glob('**/*.{ts,tsx}').scan({
    cwd: resolve(ROOT, guarded),
    absolute: true,
  })) {
    checked += 1;
    const file = relative(ROOT, path);
    violations.push(...violationsIn(file, await Bun.file(path).text()));
  }
}

if (violations.length > 0) {
  console.error(
    'A package above the transports names a broker. Declare the difference as a capability ' +
      'instead, or build the transport in packages/transports:'
  );
  for (const v of violations) console.error(`- ${v.file}:${v.line} ${v.rule}: ${v.text}`);
  process.exit(1);
}
console.log(`${checked} files in ${GUARDED_ROOTS.length} packages name no broker.`);
