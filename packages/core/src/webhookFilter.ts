import { UnsupportedOptionError } from './errors';
import { DOCUMENT_ROOTS, isDocumentPath, readPath, type WebhookDocument } from './webhookPath';

/**
 * What a webhook can filter and shape on: a request document, read by a dotted path (`webhookPath.ts`). It is data
 * only (no code, no network), so a filter or a shape an operator saves can neither run anything nor read anything
 * but the request.
 */

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
 * - A path into a request document (`body.id`) with a string, number, `true` or `false`, which is `$eq`, or with an
 *   object of operators: `$eq`, `$in`, `$gt`, `$gte`, `$lt`, `$lte` (numbers), `$startsWith` (text), `$exist`
 *   (true or false). Its type is whatever the request holds, and a value of another type does not match.
 * - `$and` and `$or` over a list of filters, `$not` over one.
 *
 * A path with no value (a `body.email` the request did not carry) matches only `$exist: false`.
 */
export type WebhookFilter = { readonly [term: string]: unknown };

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
    } else if (isDocumentPath(term)) {
      checkField(term, operand, budget);
    } else {
      bad(
        `unknown term "${term.slice(0, 40)}"; use a path under ${DOCUMENT_ROOTS.join(', ')}, $and, $or or $not`
      );
    }
  }
}

function countNode(budget: { nodes: number }): void {
  budget.nodes += 1;
  if (budget.nodes > MAX_FILTER_NODES) bad(`must not have more than ${MAX_FILTER_NODES} terms`);
}

function checkOperand(field: string, operator: string, arg: unknown): void {
  if (typeof arg === 'string' && arg.length <= MAX_FILTER_STRING) return;
  if (typeof arg === 'number' && Number.isFinite(arg)) return;
  if (typeof arg === 'boolean') return;
  bad(
    `${field} ${operator} takes text of at most ${MAX_FILTER_STRING} characters, a number, true or false`
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
      if (typeof arg !== 'number' || !Number.isFinite(arg))
        bad(`${field} ${operator} takes a number`);
    } else if (operator === '$startsWith') {
      if (typeof arg !== 'string' || arg === '') bad(`${field} $startsWith takes non-empty text`);
      checkOperand(field, operator, arg);
    } else if (operator === '$exist') {
      if (typeof arg !== 'boolean') bad(`${field} $exist takes true or false`);
    } else {
      bad(`unknown operator "${operator.slice(0, 40)}" on ${field}`);
    }
  }
}

/** Whether the document passes a filter `validateFilter` accepted. Anything it does not understand fails. */
export function matchesFilter(filter: WebhookFilter, document: WebhookDocument): boolean {
  return Object.entries(filter).every(([term, operand]) => {
    if (term === '$and')
      return (operand as WebhookFilter[]).every((p) => matchesFilter(p, document));
    if (term === '$or') return (operand as WebhookFilter[]).some((p) => matchesFilter(p, document));
    if (term === '$not') return !matchesFilter(operand as WebhookFilter, document);
    if (!isDocumentPath(term)) return false;
    return matchesField(readPath(document, term) ?? null, operand);
  });
}

function matchesField(value: unknown, operand: unknown): boolean {
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
