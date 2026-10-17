import { Glob } from 'bun';
import { resolve } from 'node:path';
import { WORKFLOW_GLOBS, workflowViolationsIn } from './workflowBoundary';

const ROOT = resolve(import.meta.dir, '..');
const violations = [];
let checked = 0;
for (const pattern of WORKFLOW_GLOBS) {
  for await (const file of new Glob(pattern).scan({ cwd: ROOT })) {
    checked += 1;
    violations.push(...workflowViolationsIn(file, await Bun.file(resolve(ROOT, file)).text()));
  }
}

if (violations.length > 0) {
  console.error('Workflow code reaches past the store port and the SDK queue:');
  for (const v of violations) console.error(`- ${v.file}:${v.line} ${v.rule}: ${v.text}`);
  process.exit(1);
}
if (checked === 0) {
  console.error('The workflow boundary check found no files; its patterns are wrong.');
  process.exit(1);
}
console.log(`${checked} workflow files use no SQLite, socket or Qelay client.`);
