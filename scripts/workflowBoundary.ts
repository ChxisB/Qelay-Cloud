/**
 * The rule behind "the workflow engine runs on the store port and the SDK queue": workflow code
 * never reaches for SQLite, a TCP socket, or the upstream Qelay client or its `Qelay` class. The
 * engine persists through `WorkflowStorePort` and moves its steps through `Queue`, `Worker` and
 * `FlowProducer`.
 */

import { withoutComments, type Violation } from './transportBoundary';

/** Glob patterns, relative to the repository root, of the files that hold workflow code. */
export const WORKFLOW_GLOBS = [
  'packages/sdk/src/workflow/**/*.ts',
  'packages/core/src/workflow*.ts',
  'packages/maintenance/src/workflowSweep.ts',
] as const;

const SQLITE_PATTERN = /(?:from\s*|import\s*\(\s*|require\s*\(\s*)(['"])(?:bun:sqlite|(?:node:)?sqlite3?|better-sqlite3)\1/;
const SOCKET_PATTERN =
  /(?:from\s*|import\s*\(\s*|require\s*\(\s*)(['"])(?:node:)?(?:net|tls|dgram)\1|\bBun\.(?:connect|listen)\s*\(/;
const CLIENT_PATTERN =
  /(?:from\s*|import\s*\(\s*|require\s*\(\s*)(['"])(?:@?qelay(?:\/[^'"]*)?|(?:\.\.?\/)+(?:[\w.-]+\/)*(?:client|qelay)(?:\/[^'"]*)?)\1/;
/** The class used as a value or a type: constructed, imported by name, extended, or annotated. */
const CLASS_PATTERN =
  /\bnew\s+Qelay(?:Client|Connection)?\b|\bimport\s*(?:type\s*)?\{[^}]*\bQelay(?:Client|Connection)?\b|\bextends\s+Qelay\b|[:<]\s*Qelay(?:Client|Connection)?\s*[>,;)=|&]/;

export function workflowViolationsIn(file: string, source: string): Violation[] {
  const lines = withoutComments(source).split('\n');
  const rules: ReadonlyArray<readonly [string, RegExp]> = [
    ['imports SQLite', SQLITE_PATTERN],
    ['opens a socket', SOCKET_PATTERN],
    ['imports the Qelay client', CLIENT_PATTERN],
    ['names the Qelay client class', CLASS_PATTERN],
  ];
  const found: Violation[] = [];
  lines.forEach((text, index) => {
    for (const [rule, pattern] of rules) {
      if (pattern.test(text)) found.push({ file, line: index + 1, rule, text: text.trim() });
    }
  });
  return found;
}
