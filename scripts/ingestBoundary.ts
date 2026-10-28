import { posix } from 'node:path';
import type { Violation } from './transportBoundary';
import { withoutComments } from './transportBoundary';

/**
 * The rule behind "the ingest only validates, stores and answers" (DESIGN.md D12): `packages/ingest/src` imports its own
 * files, Node, Bun, `@qelay-cloud/core` and `@qelay-cloud/store-postgres`, and nothing else. A transport, the sender, the
 * Control API or a new dependency would give the public process a way to call out, so each one is a violation.
 */
export const INGEST_ROOT = 'packages/ingest/src';

const ALLOWED_PACKAGES = new Set(['bun', '@qelay-cloud/core', '@qelay-cloud/store-postgres']);
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s*)(['"])([^'"]+)\1/gu;

function refusal(file: string, specifier: string): string | null {
  if (specifier.startsWith('.')) {
    const target = posix.normalize(posix.join(posix.dirname(file), specifier));
    return target === INGEST_ROOT || target.startsWith(`${INGEST_ROOT}/`)
      ? null
      : 'imports a file outside the ingest package';
  }
  if (specifier.startsWith('node:') || ALLOWED_PACKAGES.has(specifier)) return null;
  return 'imports a package the ingest may not use';
}

export function ingestViolationsIn(file: string, source: string): Violation[] {
  const found: Violation[] = [];
  withoutComments(source)
    .split('\n')
    .forEach((text, index) => {
      for (const match of text.matchAll(SPECIFIER)) {
        const rule = refusal(file, match[2]!);
        if (rule !== null) found.push({ file, line: index + 1, rule, text: text.trim() });
      }
    });
  return found;
}
