/**
 * The rule behind "a broker difference is a capability flag, not a branch": the packages that sit
 * above the transports never name one. They see a `DeliveryTransport` and what it declares, and
 * `packages/transports` is the single place that turns a configured name into an instance.
 */

/** Source directories that must stay broker-agnostic. */
export const GUARDED_ROOTS = [
  'packages/core/src',
  'packages/sdk/src',
  'packages/store-postgres/src',
  'packages/maintenance/src',
  'packages/control-api/src',
  'packages/ingest/src',
] as const;

export interface Violation {
  readonly file: string;
  readonly line: number;
  readonly rule: string;
  readonly text: string;
}

const MODULE_PATTERN =
  /(?:from\s*|import\s*\(\s*|require\s*\(\s*)(['"])((?:@qelay-cloud\/transport-(?:aws|gcp|local)|@aws-sdk\/|@google-cloud\/|(?:\.\.?\/)+(?:[\w.-]+\/)*transport-(?:aws|gcp|local))[^'"]*)\1/g;
const KIND_PATTERN = /(['"`])(gcp-pubsub|aws-sqs|postgres-local|sqs-emulator|pubsub-emulator)\1/g;
const CLASS_PATTERN = /\b(SqsTransport|PubSubTransport|PostgresLocalTransport|MemoryTransport)\b/g;

/** Source with comments blanked out (same length, same lines), so a doc comment may name a broker. */
export function withoutComments(source: string): string {
  let out = '';
  let quote: string | null = null;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i]!;
    const next = source[i + 1];
    if (quote !== null) {
      out += char;
      if (char === '\\') {
        out += next ?? '';
        i += 1;
      } else if (char === quote) quote = null;
      continue;
    }
    if (char === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') {
        out += ' ';
        i += 1;
      }
      i -= 1;
      continue;
    }
    if (char === '/' && next === '*') {
      i += 2;
      out += '  ';
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
        out += source[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      out += '  ';
      i += 1;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') quote = char;
    out += char;
  }
  return out;
}

export function violationsIn(file: string, source: string): Violation[] {
  const code = withoutComments(source);
  const lines = code.split('\n');
  const found: Violation[] = [];
  const rules: ReadonlyArray<readonly [string, RegExp]> = [
    ['imports a broker package or SDK', MODULE_PATTERN],
    ['names a broker kind', KIND_PATTERN],
    ['names a transport class', CLASS_PATTERN],
  ];
  lines.forEach((text, index) => {
    for (const [rule, pattern] of rules) {
      pattern.lastIndex = 0;
      if (pattern.test(text)) {
        found.push({ file, line: index + 1, rule, text: text.trim() });
      }
    }
  });
  return found;
}
