import { randomBytes } from 'node:crypto';

/** A namespace no other test file shares, so jobs and bells of different files never meet. */
export function uniqueNamespace(): string {
  return `t${randomBytes(6).toString('hex')}`;
}

/** Polls `check` until it is true; throws with `what` after `timeoutMs`. */
export async function waitFor(
  check: () => boolean | Promise<boolean>,
  what: string,
  timeoutMs = 10_000,
  everyMs = 20
): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > until) throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what}`);
    await Bun.sleep(everyMs);
  }
}
