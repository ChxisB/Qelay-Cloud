import { UnsupportedOptionError } from './errors';

/**
 * What a webhook can filter and shape on: the fields of one journal event, as the delivery writer
 * has them. It is data only (no code, no network, no job payload), so a filter or a shape an
 * operator saves can neither run anything nor read a job's `data` or result.
 */
export const SUBJECT_FIELDS = [
  'event',
  'queue',
  'jobId',
  'state',
  'error',
  'progress',
  'occurredAt',
] as const;

export type SubjectField = (typeof SUBJECT_FIELDS)[number];

export interface WebhookSubject {
  /** The webhook event name (`job.failed`), not the journal's. */
  readonly event: string;
  readonly queue: string;
  readonly jobId: string;
  /** Epoch milliseconds. */
  readonly occurredAt: number;
  readonly state?: string | null;
  readonly error?: string | null;
  readonly progress?: number | null;
}

export const isSubjectField = (name: string): name is SubjectField =>
  (SUBJECT_FIELDS as readonly string[]).includes(name);

export const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Terms in one filter (every field, operator and logical term counts). */
export const MAX_FILTER_NODES = 50;
export const MAX_FILTER_DEPTH = 4;
/** Entries of `$in`, and filters under `$and` / `$or`. */
export const MAX_FILTER_LIST = 20;
export const MAX_FILTER_STRING = 256;

/**
 * A filter saved with a webhook: an object whose terms must all hold.
 *
 * - A field of the subject (`SUBJECT_FIELDS`) with a string or number, which is `$eq`, or with an
 *   object of operators: `$eq`, `$in`, `$gt`, `$gte`, `$lt`, `$lte` (numbers: `progress`,
 *   `occurredAt`), `$startsWith` (text fields), `$exist` (true or false).
 * - `$and` and `$or` over a list of filters, `$not` over one.
 *
 * A field with no value (an `error` on a pushed event) matches only `$exist: false`.
 */
export type WebhookFilter = { readonly [term: string]: unknown };

const NUMBER_FIELDS: ReadonlySet<string> = new Set(['progress', 'occurredAt']);
const COMPARES = ['$gt', '$gte', '$lt', '$lte'] as const;

function bad(message: string): never {
  throw new UnsupportedOptionError('filter', message);
}

/** Returns the filter when it is valid; throws `UnsupportedOptionError('filter', …)` naming the first fault. */
export function validateFilter(value: unknown): WebhookFilter {
  checkFilter(value, 1, { nodes: 0 });
  return value as WebhookFilter;
}

function checkFilter(node: unknown, depth: number, budget: { nodes: number }): void {
  if (!isPlainObject(node) || Object.keys(node).length === 0) bad('must be a non-empty object');
  if (depth > MAX_FILTER_DEPTH) bad(`must not nest deeper than ${MAX_FILTER_DEPTH}`);
  for (const [term, operand] of Object.entries(node)) {
    countNode(budget);
    if (term === '$and' || term === '$or') {
      if (!Array.isArray(operand) || operand.length < 1 || operand.length > MAX_FILTER_LIST) {
        bad(`${term} takes 1 to ${MAX_FILTER_LIST} filters`);
      }
      for (const part of operand) checkFilter(part, depth + 1, budget);
    } else if (term === '$not') {
      checkFilter(operand, depth + 1, budget);
    } else if (isSubjectField(term)) {
      checkField(term, operand, budget);
    } else {
      bad(
        `unknown term "${term.slice(0, 40)}"; use ${SUBJECT_FIELDS.join(', ')}, $and, $or or $not`
      );
    }
  }
}

function countNode(budget: { nodes: number }): void {
  budget.nodes += 1;
  if (budget.nodes > MAX_FILTER_NODES) bad(`must not have more than ${MAX_FILTER_NODES} terms`);
}

function checkOperand(field: string, operator: string, arg: unknown): void {
  const numeric = NUMBER_FIELDS.has(field);
  if (typeof arg === 'string' && !numeric && arg.length <= MAX_FILTER_STRING) return;
  if (typeof arg === 'number' && numeric && Number.isFinite(arg)) return;
  bad(
    numeric
      ? `${field} ${operator} takes a number`
      : `${field} ${operator} takes text of at most ${MAX_FILTER_STRING} characters`
  );
}

function checkField(field: string, operand: unknown, budget: { nodes: number }): void {
  if (!isPlainObject(operand)) return checkOperand(field, '$eq', operand);
  if (Object.keys(operand).length === 0) bad(`${field} needs an operator`);
  for (const [operator, arg] of Object.entries(operand)) {
    countNode(budget);
    if (operator === '$eq') {
      checkOperand(field, operator, arg);
    } else if (operator === '$in') {
      if (!Array.isArray(arg) || arg.length < 1 || arg.length > MAX_FILTER_LIST) {
        bad(`${field} $in takes 1 to ${MAX_FILTER_LIST} values`);
      }
      for (const entry of arg) checkOperand(field, operator, entry);
    } else if ((COMPARES as readonly string[]).includes(operator)) {
      if (!NUMBER_FIELDS.has(field)) bad(`${operator} applies to progress and occurredAt only`);
      checkOperand(field, operator, arg);
    } else if (operator === '$startsWith') {
      if (NUMBER_FIELDS.has(field) || typeof arg !== 'string' || arg === '') {
        bad(`${field} $startsWith takes non-empty text, and applies to text fields only`);
      }
      checkOperand(field, operator, arg);
    } else if (operator === '$exist') {
      if (typeof arg !== 'boolean') bad(`${field} $exist takes true or false`);
    } else {
      bad(`unknown operator "${operator.slice(0, 40)}" on ${field}`);
    }
  }
}

/** Whether the subject passes a filter `validateFilter` accepted. Anything it does not understand fails. */
export function matchesFilter(filter: WebhookFilter, subject: WebhookSubject): boolean {
  return Object.entries(filter).every(([term, operand]) => {
    if (term === '$and')
      return (operand as WebhookFilter[]).every((p) => matchesFilter(p, subject));
    if (term === '$or') return (operand as WebhookFilter[]).some((p) => matchesFilter(p, subject));
    if (term === '$not') return !matchesFilter(operand as WebhookFilter, subject);
    if (!isSubjectField(term)) return false;
    return matchesField(subject[term] ?? null, operand);
  });
}

function matchesField(value: string | number | null, operand: unknown): boolean {
  const operators = isPlainObject(operand) ? operand : { $eq: operand };
  return Object.entries(operators).every(([operator, arg]) => {
    if (operator === '$exist') return (value !== null) === arg;
    if (value === null) return false;
    switch (operator) {
      case '$eq':
        return value === arg;
      case '$in':
        return (arg as unknown[]).includes(value);
      case '$gt':
        return typeof value === 'number' && value > (arg as number);
      case '$gte':
        return typeof value === 'number' && value >= (arg as number);
      case '$lt':
        return typeof value === 'number' && value < (arg as number);
      case '$lte':
        return typeof value === 'number' && value <= (arg as number);
      case '$startsWith':
        return typeof value === 'string' && value.startsWith(arg as string);
      default:
        return false;
    }
  });
}
