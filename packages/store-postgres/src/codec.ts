import type { Codec } from '@qelay-cloud/core';
import { Packr, Unpackr } from 'msgpackr';

/**
 * The payload codec: msgpack through `msgpackr`, in the configuration the upstream queue uses
 * (`../qelay/src/shared/msgpack.ts`) plus the two things upstream's does not do:
 *
 * - **bigint of any size.** `useBigIntExtension` stores a bigint over 64 bits as an extension
 *   instead of throwing a `RangeError`.
 * - **A `__proto__` key survives.** `msgpackr` rewrites that key to `__proto_` on decode, so a
 *   payload `{ "__proto__": 1 }` would come back changed. The key is escaped on the wire with a
 *   leading NUL and restored on decode. The check is a byte search, so a payload without the
 *   marker pays nothing for this.
 *
 * Date, Map, Set, Uint8Array, RegExp and Error round-trip. Records mode writes each object's key
 * list inline in the payload, so any decoder instance reads any payload on its own.
 */
const OPTIONS = { useBigIntExtension: true, moreTypes: true } as const;
const MARKER = Buffer.from('__proto__');
const NUL = '\u0000';
const PROTO = '__proto__';

/** True for `__proto__` preceded by at least `leading` NULs and nothing else. */
function isProtoKey(key: string, leading: number): boolean {
  if (!key.endsWith(PROTO)) return false;
  const prefix = key.length - PROTO.length;
  if (prefix < leading) return false;
  for (let at = 0; at < prefix; at++) if (key[at] !== NUL) return false;
  return true;
}

const escapeKey = (key: string) => (isProtoKey(key, 0) ? `${NUL}${key}` : key);
const unescapeKey = (key: string) => (isProtoKey(key, 1) ? key.slice(1) : key);

const hasMarker = (bytes: Uint8Array) =>
  Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).includes(MARKER);

/** Containers `msgpackr` writes by value and that this module leaves alone. */
const isOpaque = (value: object) =>
  value instanceof Date ||
  value instanceof RegExp ||
  value instanceof Error ||
  value instanceof ArrayBuffer ||
  ArrayBuffer.isView(value);

/**
 * A copy of `value` whose plain-object keys went through `mapKey`. Class instances become plain
 * objects, which is what the wire format makes of them anyway. Own properties are defined, not
 * assigned, so a key named `__proto__` becomes a property and never touches the prototype.
 */
function rewrite(value: unknown, mapKey: (key: string) => string): unknown {
  if (typeof value !== 'object' || value === null || isOpaque(value)) return value;
  if (Array.isArray(value)) return value.map((item) => rewrite(item, mapKey));
  if (value instanceof Map) {
    return new Map([...value].map(([k, v]) => [rewrite(k, mapKey), rewrite(v, mapKey)]));
  }
  if (value instanceof Set) return new Set([...value].map((item) => rewrite(item, mapKey)));
  const copy: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    Object.defineProperty(copy, mapKey(key), {
      value: rewrite((value as Record<string, unknown>)[key], mapKey),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return copy;
}

export function createMsgpackCodec(): Codec {
  const packr = new Packr(OPTIONS);
  const unpackr = new Unpackr(OPTIONS);
  return {
    encode(value) {
      let packed = packr.pack(value);
      if (hasMarker(packed)) packed = packr.pack(rewrite(value, escapeKey));
      // `pack` returns a view into a buffer it reuses for the next call, so copy it out.
      return new Uint8Array(packed);
    },
    decode(bytes) {
      const value = unpackr.unpack(bytes);
      return hasMarker(bytes) ? rewrite(value, unescapeKey) : value;
    },
  };
}
