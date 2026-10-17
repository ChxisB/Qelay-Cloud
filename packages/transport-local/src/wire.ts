import type { Bell } from '@qelay-cloud/core';

/**
 * What goes through `NOTIFY`. A payload is a JSON object, one of:
 *
 * - a bell: `{"n": namespace, "q": queue, "j": jobId, "d": delayMs}`, `j` and `d` only when set. A
 *   notification reaches every listener, so a listener holds a delayed bell for `d` before it
 *   acts on it: a bell is never delivered earlier than its delay.
 * - a heartbeat: `{"h": instance, "s": sequence}`, which a transport sends to itself to learn that
 *   its `LISTEN` connection still receives.
 *
 * Anything else on the channel (another program, a future format) decodes to null and is ignored.
 */

/** `NOTIFY` refuses a payload of 8,000 bytes or more. */
export const MAX_NOTIFY_BYTES = 7_999;

export type Decoded =
  | { readonly kind: 'bell'; readonly bell: Bell; readonly delayMs: number }
  | { readonly kind: 'heartbeat'; readonly instance: string; readonly sequence: number };

/**
 * The payload for a bell, or null when it does not fit. `jobId` is only a hint (the claim does not
 * need it), so a bell whose job id is too long for the limit is sent without it.
 */
export function encodeBell(bell: Bell, delayMs: number): string | null {
  const base: Record<string, string | number> = { n: bell.namespace, q: bell.queue };
  if (delayMs > 0) base.d = delayMs;
  const full = JSON.stringify(bell.jobId === undefined ? base : { ...base, j: bell.jobId });
  if (Buffer.byteLength(full) <= MAX_NOTIFY_BYTES) return full;
  const bare = JSON.stringify(base);
  return Buffer.byteLength(bare) <= MAX_NOTIFY_BYTES ? bare : null;
}

export const encodeHeartbeat = (instance: string, sequence: number): string =>
  JSON.stringify({ h: instance, s: sequence });

export function decode(payload: string): Decoded | null {
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const fields = value as Record<string, unknown>;
  if (typeof fields.h === 'string' && typeof fields.s === 'number') {
    return { kind: 'heartbeat', instance: fields.h, sequence: fields.s };
  }
  if (typeof fields.n !== 'string' || typeof fields.q !== 'string') return null;
  const delayMs = typeof fields.d === 'number' && fields.d > 0 ? fields.d : 0;
  const jobId = typeof fields.j === 'string' ? fields.j : undefined;
  const bell: Bell = {
    namespace: fields.n,
    queue: fields.q,
    ...(jobId === undefined ? {} : { jobId }),
  };
  return { kind: 'bell', bell, delayMs };
}
