import { LONE_SURROGATE } from './prepare';

/** A job's progress as the columns hold it: a number from 0 to 100 and an optional text. */
export interface StoredProgress {
  readonly progress: number;
  readonly message?: string;
}

/**
 * The stored form of a progress update, adapted from Qelay's `normalizeProgress` (see
 * docs/PORTING.md). It never throws, so a processor's `updateProgress` cannot fail its job:
 * - a number is kept, clamped to 0..100; NaN is 0;
 * - an object (BullMQ object progress) is 0 with its JSON as the message;
 * - a numeric string, a boolean and null are `Number(value)` (`'50'` is 50, `true` is 1, `null` is 0);
 * - any other string (`'downloading'`) is 0 with the text as the message, unless a message was given;
 * - any other value is 0.
 * A message the column cannot hold (a NUL or a lone surrogate) is dropped, not an error.
 */
export function normalizeProgress(progress: unknown, message?: string): StoredProgress {
  const { value, text } = interpret(progress);
  const kept = storable(message ?? text);
  return kept === undefined
    ? { progress: clamp(value) }
    : { progress: clamp(value), message: kept };
}

function interpret(progress: unknown): { value: number; text?: string } {
  if (typeof progress === 'number') return { value: progress };
  if (typeof progress === 'object' && progress !== null) {
    return { value: 0, text: progressJson(progress) };
  }
  if (typeof progress === 'boolean' || progress === null) return { value: Number(progress) };
  if (typeof progress === 'string') {
    const number = Number(progress); // '' is 0
    return Number.isNaN(number) ? { value: 0, text: progress } : { value: number };
  }
  return { value: 0 };
}

const clamp = (value: number): number =>
  Number.isNaN(value) ? 0 : Math.min(100, Math.max(0, value));

function storable(text: string | undefined): string | undefined {
  return text === undefined || text.includes('\0') || LONE_SURROGATE.test(text) ? undefined : text;
}

/** An object progress as JSON; one JSON cannot encode (a cycle, a bigint) has no message. */
function progressJson(progress: object): string | undefined {
  try {
    return JSON.stringify(progress);
  } catch {
    return undefined;
  }
}
