/**
 * Encodes job payloads for storage. The msgpackr implementation lives in `store-postgres`, so
 * `core` stays free of runtime dependencies. A round trip preserves Date, Map and bigint.
 */
export interface Codec {
  encode(value: unknown): Uint8Array;
  decode(bytes: Uint8Array): unknown;
}
