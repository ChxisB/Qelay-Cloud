import { ApiError } from '../errors';

/**
 * Job payloads on the wire. The store keeps a payload as msgpack, which holds more than JSON does
 * (bigint, Date, Map, Set, bytes, `undefined`, NaN and the infinities). A value JSON cannot hold is
 * written as a tagged object, `{ "$type": "bigint", "value": "9007199254740993" }`, so the panel
 * shows it and `fromWire` gets back exactly what was stored. An object of the payload that has a
 * `$type` key of its own is wrapped (`{ "$type": "object", "value": {...} }`), so a tag is never
 * ambiguous. Tags: bigint, date, number (NaN, Infinity, -0), undefined, bytes, map, set, object,
 * and `truncated` and `depth`, which are written by this service and never accepted back.
 */

export type Wire = null | boolean | number | string | Wire[] | { [key: string]: Wire };

export interface WireResult {
  readonly value: Wire;
  /** True when `value` is a `truncated` marker in place of the payload. */
  readonly truncated: boolean;
}

const TAG = '$type';
const MAX_DEPTH = 64;
/** Characters of a long string kept in a truncation marker. */
const PREVIEW_CHARS = 200;

/** Thrown inside the walk the moment the budget is spent: the rest of the value is not visited. */
class OverBudget extends Error {}

interface Walk {
  budget: number;
}

const spend = (walk: Walk, bytes: number): void => {
  walk.budget -= bytes;
  if (walk.budget < 0) throw new OverBudget();
};

const tag = (name: string, fields: Record<string, Wire> = {}): Wire => ({ [TAG]: name, ...fields });

const bytesOf = (view: ArrayBufferView): Buffer =>
  Buffer.from(view.buffer, view.byteOffset, view.byteLength);

function encode(value: unknown, walk: Walk, depth: number): Wire {
  if (value === null) {
    spend(walk, 4);
    return null;
  }
  switch (typeof value) {
    case 'string':
      spend(walk, value.length + 2);
      return value;
    case 'boolean':
      spend(walk, 5);
      return value;
    case 'number':
      spend(walk, 8);
      if (Number.isFinite(value) && !Object.is(value, -0)) return value;
      return tag('number', { value: Object.is(value, -0) ? '-0' : String(value) });
    case 'bigint': {
      const text = value.toString();
      spend(walk, text.length + 24);
      return tag('bigint', { value: text });
    }
    case 'undefined':
      spend(walk, 24);
      return tag('undefined');
    case 'function':
    case 'symbol':
      return tag('unsupported', { kind: typeof value });
  }
  if (depth >= MAX_DEPTH) return tag('depth');
  if (value instanceof Date) {
    spend(walk, 48);
    return tag('date', {
      value: Number.isNaN(value.getTime()) ? null : value.toISOString(),
    });
  }
  if (ArrayBuffer.isView(value)) {
    spend(walk, Math.ceil((value.byteLength * 4) / 3) + 32);
    const view = value.constructor.name;
    return tag('bytes', {
      base64: bytesOf(value).toString('base64'),
      ...(view === 'Uint8Array' || view === 'Buffer' ? {} : { view }),
    });
  }
  if (value instanceof Map) {
    spend(walk, 24);
    const entries = [...value].map(([key, item]): Wire => [
      encode(key, walk, depth + 1),
      encode(item, walk, depth + 1),
    ]);
    return tag('map', { entries });
  }
  if (value instanceof Set) {
    spend(walk, 24);
    return tag('set', { values: [...value].map((item) => encode(item, walk, depth + 1)) });
  }
  if (Array.isArray(value)) {
    spend(walk, 2);
    return Array.from(value, (item) => encode(item, walk, depth + 1));
  }
  const entries = Object.entries(value as Record<string, unknown>).map(([key, item]) => {
    spend(walk, key.length + 4);
    return [key, encode(item, walk, depth + 1)] as const;
  });
  // `Object.fromEntries` defines each key, so a payload key named `__proto__` stays a plain key.
  const record = Object.fromEntries(entries) as { [key: string]: Wire };
  return Object.hasOwn(value as object, TAG) ? tag('object', { value: record }) : record;
}

function describe(value: unknown): Record<string, Wire> {
  if (typeof value === 'string') {
    return { kind: 'string', length: value.length, preview: value.slice(0, PREVIEW_CHARS) };
  }
  if (ArrayBuffer.isView(value)) return { kind: 'bytes', length: value.byteLength };
  if (value instanceof Map) return { kind: 'map', length: value.size };
  if (value instanceof Set) return { kind: 'set', length: value.size };
  if (Array.isArray(value)) return { kind: 'array', length: value.length };
  return { kind: 'object', length: Object.keys(value as object).length };
}

/**
 * `value` as JSON-safe data that costs at most about `maxBytes` of JSON. A payload over that is not
 * cut in the middle (half a document misleads): it is replaced by a marker that says what it was.
 */
export function toWire(value: unknown, options: { readonly maxBytes: number }): WireResult {
  try {
    return { value: encode(value, { budget: options.maxBytes }, 0), truncated: false };
  } catch (error) {
    if (!(error instanceof OverBudget)) throw error;
    return {
      value: tag('truncated', { ...describe(value), maxBytes: options.maxBytes }),
      truncated: true,
    };
  }
}

const bad = (message: string): ApiError => ApiError.invalid(`the payload is not valid: ${message}`);

function decodeTag(name: unknown, node: { [key: string]: unknown }, depth: number): unknown {
  switch (name) {
    case 'bigint':
      if (typeof node.value !== 'string' || !/^-?\d{1,4000}$/.test(node.value)) {
        throw bad('a bigint tag needs a decimal string');
      }
      return BigInt(node.value);
    case 'number': {
      const known: Record<string, number> = {
        NaN: Number.NaN,
        Infinity: Number.POSITIVE_INFINITY,
        '-Infinity': Number.NEGATIVE_INFINITY,
        '-0': -0,
      };
      const text = node.value;
      if (typeof text !== 'string' || !Object.hasOwn(known, text)) {
        throw bad('a number tag is NaN, Infinity, -Infinity or -0');
      }
      return known[text];
    }
    case 'undefined':
      return undefined;
    case 'date': {
      if (node.value === null) return new Date(Number.NaN);
      const date = typeof node.value === 'string' ? new Date(node.value) : null;
      if (date === null || Number.isNaN(date.getTime())) throw bad('a date tag needs an ISO date');
      return date;
    }
    case 'bytes': {
      if (typeof node.base64 !== 'string') throw bad('a bytes tag needs a base64 string');
      return new Uint8Array(Buffer.from(node.base64, 'base64'));
    }
    case 'map': {
      if (!Array.isArray(node.entries)) throw bad('a map tag needs entries');
      return new Map(
        node.entries.map((entry: unknown) => {
          if (!Array.isArray(entry) || entry.length !== 2) throw bad('a map entry is a pair');
          return [decode(entry[0], depth + 1), decode(entry[1], depth + 1)] as const;
        })
      );
    }
    case 'set': {
      if (!Array.isArray(node.values)) throw bad('a set tag needs values');
      return new Set(node.values.map((item: unknown) => decode(item, depth + 1)));
    }
    case 'object': {
      const inner = node.value;
      if (typeof inner !== 'object' || inner === null || Array.isArray(inner)) {
        throw bad('an object tag wraps an object');
      }
      return plain(inner as { [key: string]: unknown }, depth);
    }
    case 'truncated':
      throw bad('it holds a truncated marker: the payload shown was cut, so it cannot be saved');
    default:
      throw bad(
        `"${typeof name === 'string' ? name.slice(0, 40) : typeof name}" is not a known tag`
      );
  }
}

function plain(node: { [key: string]: unknown }, depth: number): unknown {
  return Object.fromEntries(
    Object.entries(node).map(([key, item]) => [key, decode(item, depth + 1)] as const)
  );
}

function decode(node: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) throw bad(`it is nested deeper than ${MAX_DEPTH} levels`);
  if (typeof node !== 'object' || node === null) return node;
  if (Array.isArray(node)) return node.map((item) => decode(item, depth + 1));
  const record = node as { [key: string]: unknown };
  return Object.hasOwn(record, TAG) ? decodeTag(record[TAG], record, depth) : plain(record, depth);
}

/**
 * The value a request body's payload stands for: the inverse of `toWire`. A `truncated` marker or a
 * tag this service does not write is a 400, so a payload that was cut for display is never saved.
 */
export const fromWire = (wire: unknown): unknown => decode(wire, 0);
