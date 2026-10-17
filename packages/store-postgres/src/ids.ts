/**
 * UUIDv7 job ids (RFC 9562): a 48-bit millisecond timestamp, then a 12-bit counter, then 62 random
 * bits. Ids sort in creation order, which the LIFO index and `listJobs` rely on.
 *
 * Inside one process the order is strict. Two ids made in the same millisecond take the next
 * counter value, a full counter moves to the next millisecond, and a clock that steps back keeps
 * the last millisecond. Across processes ids that share a millisecond sort by their random tail,
 * which is the ordering any UUIDv7 gives.
 */
export interface UuidV7 {
  /** An id for `nowMs`, the store's time for the operation (the database clock or the injected one). */
  next(nowMs: number): string;
}

const COUNTER_LIMIT = 0x1000;
const hex = (value: number, width: number) => value.toString(16).padStart(width, '0');

export function createUuidV7(): UuidV7 {
  let lastMs = 0;
  let counter = 0;
  return {
    next(nowMs) {
      const ms = Math.max(Math.floor(nowMs), lastMs);
      if (ms === lastMs && lastMs !== 0) {
        counter += 1;
        if (counter >= COUNTER_LIMIT) {
          lastMs += 1;
          counter = 0;
        }
      } else {
        lastMs = ms;
        counter = 0;
      }
      const tail = crypto.getRandomValues(new Uint8Array(8));
      tail[0] = ((tail[0] ?? 0) & 0x3f) | 0x80;
      const rest = Array.from(tail, (byte) => hex(byte, 2)).join('');
      const time = hex(lastMs, 12);
      return `${time.slice(0, 8)}-${time.slice(8)}-7${hex(counter, 3)}-${rest.slice(0, 4)}-${rest.slice(4)}`;
    },
  };
}
