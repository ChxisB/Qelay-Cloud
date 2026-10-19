import { UnsupportedOptionError } from './errors';
import type { SubjectField, WebhookFilter, WebhookSubject } from './webhookFilter';
import { isPlainObject, isSubjectField, matchesFilter, SUBJECT_FIELDS } from './webhookFilter';

/**
 * A webhook's body template. The delivery writer renders it once, when it writes the delivery row,
 * and stores the bytes: every attempt sends exactly those bytes and signs them, so a retry never
 * differs from the first attempt. A template is JSON data, evaluated by this file's two functions
 * and nothing else: no code, no network, no job payload.
 *
 * - The top level is an object; objects, arrays and plain values nest inside it.
 * - `{ "$": "<field>" }` is replaced by the field of the event (`SUBJECT_FIELDS`); with
 *   `"default": <plain value>` it takes that when the event has none, and without one the key is left
 *   out (an array entry becomes null).
 * - Keys starting with `$` are reserved.
 * - A text value taken from the event is cut to `MAX_REF_CHARS`. A body that still passes
 *   `MAX_SHAPED_BODY_BYTES` is not sent: the delivery is recorded as failed with that reason.
 *
 * Object keys come out shortest first, then alphabetically, whatever order the template has them in.
 *
 * The delivery's id is not a field (the row does not exist yet); it travels in the `X-Webhook-Id` header.
 */
export type WebhookShape = { readonly [key: string]: unknown };

export const MAX_SHAPE_NODES = 100;
export const MAX_SHAPE_DEPTH = 6;
export const MAX_SHAPE_KEY_CHARS = 64;
/** The template's own JSON text. */
export const MAX_SHAPE_BYTES = 8 * 1024;
export const MAX_REF_CHARS = 512;
export const MAX_SHAPED_BODY_BYTES = 64 * 1024;

function bad(message: string): never {
  throw new UnsupportedOptionError('shape', message);
}

const isRef = (node: Record<string, unknown>): boolean => '$' in node;

/** Returns the shape when it is valid; throws `UnsupportedOptionError('shape', …)` naming the first fault. */
export function validateShape(value: unknown): WebhookShape {
  if (!isPlainObject(value) || isRef(value) || Object.keys(value).length === 0) {
    bad('must be a non-empty object');
  }
  if (JSON.stringify(value).length > MAX_SHAPE_BYTES)
    bad(`must be at most ${MAX_SHAPE_BYTES} bytes`);
  checkNode(value, 1, { nodes: 0 });
  return value;
}

function checkNode(node: unknown, depth: number, budget: { nodes: number }): void {
  budget.nodes += 1;
  if (budget.nodes > MAX_SHAPE_NODES) bad(`must not have more than ${MAX_SHAPE_NODES} values`);
  if (node === null || typeof node === 'string' || typeof node === 'boolean') return;
  if (typeof node === 'number') {
    if (!Number.isFinite(node)) bad('numbers must be finite');
    return;
  }
  if (depth > MAX_SHAPE_DEPTH) bad(`must not nest deeper than ${MAX_SHAPE_DEPTH}`);
  if (Array.isArray(node)) {
    for (const entry of node) checkNode(entry, depth + 1, budget);
    return;
  }
  if (!isPlainObject(node)) bad('holds a value JSON cannot carry');
  if (isRef(node)) return checkRef(node);
  for (const [key, entry] of Object.entries(node)) {
    if (key === '' || key.length > MAX_SHAPE_KEY_CHARS || key.startsWith('$')) {
      bad(
        `key "${key.slice(0, 40)}" must be 1 to ${MAX_SHAPE_KEY_CHARS} characters and not start with $`
      );
    }
    checkNode(entry, depth + 1, budget);
  }
}

function checkRef(node: Record<string, unknown>): void {
  const field = node.$;
  if (typeof field !== 'string' || !isSubjectField(field)) {
    bad(`$ must name one of ${SUBJECT_FIELDS.join(', ')}`);
  }
  if (Object.keys(node).some((key) => key !== '$' && key !== 'default')) {
    bad('a { "$": field } value takes only "default" beside it');
  }
  const fallback = node.default;
  if (
    fallback !== undefined &&
    fallback !== null &&
    !['string', 'number', 'boolean'].includes(typeof fallback)
  ) {
    bad('default must be text, a number, a boolean or null');
  }
}

function build(node: unknown, subject: WebhookSubject): unknown {
  if (Array.isArray(node)) return node.map((entry) => build(entry, subject));
  if (!isPlainObject(node)) return node;
  if (isRef(node)) {
    const value = subject[node.$ as SubjectField];
    if (value === undefined || value === null) return node.default;
    return typeof value === 'string' ? value.slice(0, MAX_REF_CHARS) : value;
  }
  // `fromEntries` defines own properties, so a key named `__proto__` stays data.
  return Object.fromEntries(
    Object.entries(node)
      .sort(([a], [b]) => keyOrder(a, b))
      .map(([key, entry]) => [key, build(entry, subject)] as const)
      .filter(([, entry]) => entry !== undefined)
  );
}

const encoder = new TextEncoder();

/**
 * Shorter keys first, then by name: the order Postgres `jsonb` keeps a saved shape in, so the preview
 * and the stored body agree whatever order the author wrote. shortcut: names compare as UTF-16, which
 * differs from jsonb's bytes only for characters outside the Basic Multilingual Plane.
 */
const keyOrder = (a: string, b: string): number =>
  encoder.encode(a).byteLength - encoder.encode(b).byteLength || (a < b ? -1 : a > b ? 1 : 0);

export type Rendered =
  | { readonly ok: true; readonly body: string }
  | { readonly ok: false; readonly error: string };

/** The JSON text a shape makes of an event, or why there is none (too large). */
export function renderShape(shape: WebhookShape, subject: WebhookSubject): Rendered {
  const body = JSON.stringify(build(shape, subject));
  if (new TextEncoder().encode(body).byteLength > MAX_SHAPED_BODY_BYTES) {
    return { ok: false, error: `shaped body is larger than ${MAX_SHAPED_BODY_BYTES} bytes` };
  }
  return { ok: true, body };
}

/** What the test-before-saving call returns: whether the filter lets the event through, and the body it would send. */
export interface WebhookPreview {
  readonly matches: boolean;
  /** Null when the filter excludes the event, or the shaped body is too large (`error`). Without a shape, the default body (without its `id`). */
  readonly body: string | null;
  readonly error: string | null;
}

export function previewWebhook(
  spec: { readonly filter?: WebhookFilter | null; readonly shape?: WebhookShape | null },
  subject: WebhookSubject
): WebhookPreview {
  if (spec.filter != null && !matchesFilter(spec.filter, subject)) {
    return { matches: false, body: null, error: null };
  }
  if (spec.shape == null) return { matches: true, body: defaultPreview(subject), error: null };
  const rendered = renderShape(spec.shape, subject);
  return rendered.ok
    ? { matches: true, body: rendered.body, error: null }
    : { matches: true, body: null, error: rendered.error };
}

function defaultPreview(subject: WebhookSubject): string {
  const body: Record<string, unknown> = {
    event: subject.event,
    timestamp: subject.occurredAt,
    queue: subject.queue,
    jobId: subject.jobId,
  };
  if (subject.state != null) body.state = subject.state;
  if (subject.error != null) body.error = subject.error;
  if (subject.progress != null) body.progress = subject.progress;
  return JSON.stringify(body);
}
