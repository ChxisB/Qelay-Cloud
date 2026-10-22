import { formatNumber } from '@/lib/format';

const UNITS = [
  [3_600_000, 'hour'],
  [60_000, 'minute'],
  [1000, 'second'],
] as const;

/** A length of time in the largest whole unit it divides by: "1 minute", "10 seconds", "2 hours", else "1500 ms". */
export function plainDuration(ms: number): string {
  for (const [size, name] of UNITS) {
    if (ms % size !== 0) continue;
    const count = ms / size;
    return `${count} ${name}${count === 1 ? '' : 's'}`;
  }
  return `${ms} ms`;
}

/** "every minute", "every 10 seconds": a time window as a speed limit says it. */
export function everyWindow(ms: number): string {
  const text = plainDuration(ms);
  return text.startsWith('1 ') ? `every ${text.slice(2)}` : `every ${text}`;
}

export const jobsCount = (n: number): string => `${formatNumber(n)} ${n === 1 ? 'job' : 'jobs'}`;
