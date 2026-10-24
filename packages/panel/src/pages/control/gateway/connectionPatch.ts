import { type AddWebhookBody, BqError, type WebhookPatchBody } from '@/lib/bq';
import type { WebhookFull } from '@/lib/bqTypes';
import { localZone, type SendField, type SendFields, sendFieldsOf, sendPatchOf } from './sendRules';

// The limits of docs/webhooks.md. The server checks them too; the form says so before the round trip.
export const NAME_MAX = 80;
export const DESCRIPTION_MAX = 500;
export const DELAY_MAX_SECONDS = 3_600;
export const DEDUPE_MAX_SECONDS = 86_400;

/** What the edit form holds: every field as the person typed it, so a refusal can keep it. */
export interface EditFields extends SendFields {
  name: string;
  description: string;
  filter: string;
  shape: string;
  /** Seconds; empty is no delay. */
  delay: string;
  /** Seconds; empty is no deduplication. */
  dedupeWindow: string;
  /** Document paths separated by commas, like `body.id, headers.x-event`. */
  dedupeFields: string;
}

export type EditField = keyof EditFields;

/** The fields the form draws as text boxes; the send fields have their own controls. */
export type TextField = Exclude<EditField, SendField>;

export type EditResult =
  | { ok: true; patch: WebhookPatchBody }
  | { ok: false; field: EditField; msg: string };

/** The part of a connection the rules form reads and writes. */
type Rules = Pick<
  WebhookFull,
  'name' | 'description' | 'filter' | 'shape' | 'delayMs' | 'dedupe' | 'schedule' | 'batch'
>;

const DEFAULT_DEDUPE_FIELDS = 'body.id';
const rule = (value: Record<string, unknown> | null) =>
  value === null ? '' : JSON.stringify(value, null, 2);
const seconds = (ms: number | null) => (ms === null ? '' : String(ms / 1_000));

export function fieldsOf(route: Rules): EditFields {
  return {
    name: route.name ?? '',
    description: route.description ?? '',
    filter: rule(route.filter),
    shape: rule(route.shape),
    delay: seconds(route.delayMs),
    dedupeWindow: seconds(route.dedupe?.windowMs ?? null),
    dedupeFields: route.dedupe ? route.dedupe.fields.join(', ') : DEFAULT_DEDUPE_FIELDS,
    ...sendFieldsOf(route),
  };
}

const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((item) => b.includes(item));

/** A JSON object, or null for an empty box. A list, a number or a broken text is a message. */
function objectOf(text: string): Record<string, unknown> | null | string {
  if (text.trim() === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return 'This is not valid JSON.';
  }
  return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : 'This must be a JSON object, like { "body.status": "failed" }.';
}

/** Seconds typed in a box, as milliseconds; null for an empty box. */
function millisOf(text: string, max: number, what: string): number | null | string {
  if (text.trim() === '') return null;
  const value = Number(text);
  if (!Number.isFinite(value) || value < 1 || value > max) {
    return `${what} is a number of seconds from 1 to ${max.toLocaleString('en')}.`;
  }
  return Math.round(value * 1_000);
}

/**
 * The PATCH body that turns the route into what the form holds: only the keys that changed, so a save
 * never writes over something another operator changed meanwhile. A message names the first field that
 * cannot be sent. Filter and shape are checked only as JSON objects; the server checks the grammar.
 */
export function patchOf(route: Rules, fields: EditFields): EditResult {
  const was = fieldsOf(route);
  const patch: WebhookPatchBody = {};
  const refuse = (field: EditField, msg: string): EditResult => ({ ok: false, field, msg });

  const name = fields.name.trim();
  if (name.length > NAME_MAX) return refuse('name', `A name is at most ${NAME_MAX} characters.`);
  if (name !== was.name) patch.name = name === '' ? null : name;

  const description = fields.description.trim();
  if (description.length > DESCRIPTION_MAX) {
    return refuse('description', `A description is at most ${DESCRIPTION_MAX} characters.`);
  }
  if (description !== was.description) patch.description = description === '' ? null : description;

  for (const key of ['filter', 'shape'] as const) {
    if (fields[key].trim() === was[key].trim()) continue;
    const parsed = objectOf(fields[key]);
    if (typeof parsed === 'string') return refuse(key, parsed);
    if (JSON.stringify(parsed) !== JSON.stringify(route[key])) patch[key] = parsed;
  }

  const delay = millisOf(fields.delay, DELAY_MAX_SECONDS, 'A delay');
  if (typeof delay === 'string') return refuse('delay', delay);
  if (delay !== route.delayMs) patch.delayMs = delay;

  const window = millisOf(fields.dedupeWindow, DEDUPE_MAX_SECONDS, 'A window');
  if (typeof window === 'string') return refuse('dedupeWindow', window);
  if (window === null) {
    if (route.dedupe !== null) patch.dedupe = null;
  } else {
    const kept = [
      ...new Set(
        fields.dedupeFields
          .split(',')
          .map((field) => field.trim())
          .filter(Boolean)
      ),
    ];
    if (kept.length === 0) return refuse('dedupeFields', 'Name at least one field to compare.');
    const dedupe = route.dedupe;
    if (!dedupe || dedupe.windowMs !== window || !sameSet(dedupe.fields, kept)) {
      patch.dedupe = { windowMs: window, fields: kept };
    }
  }
  const send = sendPatchOf(route, fields);
  if (!send.ok) return send;
  return { ok: true, patch: { ...patch, ...send.patch } };
}

/** The request the Save button would send, as text. Empty when there is nothing to save. */
export const previewOf = (id: string, patch: WebhookPatchBody): string =>
  Object.keys(patch).length === 0 ? '' : `PATCH /webhooks/${id}\n${JSON.stringify(patch, null, 2)}`;

/** A connection with no rules: what the new connection form starts from. */
const BLANK: Rules = {
  name: null,
  description: null,
  filter: null,
  shape: null,
  delayMs: null,
  dedupe: null,
  schedule: null,
  batch: null,
};
export const blankFields = (): EditFields => ({ ...fieldsOf(BLANK), sendZone: localZone() });

/** The keys of a new connection that the form fields set; only those typed are present. */
export function rulesOf(
  fields: EditFields
): { ok: true; rules: Partial<AddWebhookBody> } | { ok: false; field: EditField; msg: string } {
  const built = patchOf(BLANK, fields);
  if (!built.ok) return built;
  // Against a blank connection a patch holds only what was typed, never a null.
  return { ok: true, rules: built.patch as Partial<AddWebhookBody> };
}

/** The server names the option it refused, so the words land beside that field. */
const FIELD_OF_OPTION: Record<string, EditField> = {
  name: 'name',
  description: 'description',
  filter: 'filter',
  shape: 'shape',
  delayMs: 'delay',
  dedupe: 'dedupeWindow',
  schedule: 'sendCron',
  batch: 'batchEvents',
};

/** The field a refusal is about, or null when it names none. */
export function refusedField(error: unknown): EditField | null {
  const option = error instanceof BqError ? error.details?.option : undefined;
  return typeof option === 'string' ? (FIELD_OF_OPTION[option] ?? null) : null;
}
