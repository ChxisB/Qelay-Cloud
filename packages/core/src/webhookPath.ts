/**
 * The event document of a request and the paths that read it (DESIGN.md D14). A path is data: it walks own
 * properties of plain objects and arrays and nothing else, so a filter, shape or dedupe an operator saves can
 * neither run code nor reach a prototype.
 *
 * shortcut: a segment is letters, digits, `_` and `-`, so a body key with a dot or a space, or a header or
 * query name with a dot, cannot be addressed; add an escape form when a provider needs one.
 */
export type WebhookDocument = { readonly [key: string]: unknown };

/** What a request document holds. `body` is there only when the request was JSON; header names are lower case. */
export const DOCUMENT_ROOTS = ['method', 'headers', 'query', 'body'] as const;
export const MAX_PATH_SEGMENTS = 8;
export const MAX_PATH_SEGMENT_CHARS = 64;

const SEGMENT = /^[A-Za-z0-9_-]+$/;
const FORBIDDEN: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/** Whether `path` is a dotted path into a request document: a root, then up to seven plain segments. */
export function isDocumentPath(path: unknown): boolean {
  if (typeof path !== 'string') return false;
  const segments = path.split('.');
  return (
    segments.length <= MAX_PATH_SEGMENTS &&
    (DOCUMENT_ROOTS as readonly string[]).includes(segments[0] ?? '') &&
    segments.every(
      (segment) =>
        segment.length <= MAX_PATH_SEGMENT_CHARS && SEGMENT.test(segment) && !FORBIDDEN.has(segment)
    )
  );
}

/** The value at `path`, or undefined. A digit segment indexes an array. Callers have validated the path when it was saved. */
export function readPath(document: WebhookDocument, path: string): unknown {
  let node: unknown = document;
  for (const segment of path.split('.')) {
    if (Array.isArray(node)) {
      node = /^\d+$/.test(segment) ? node[Number(segment)] : undefined;
    } else if (typeof node === 'object' && node !== null && Object.hasOwn(node, segment)) {
      node = (node as Record<string, unknown>)[segment];
    } else {
      return undefined;
    }
  }
  return node;
}
