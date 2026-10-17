/**
 * Waits for `work`, but no longer than `ms`: resolves `true` when it settled in time (whatever it
 * settled with: a rejection is swallowed, the caller wanted to wait, not to learn) and `false` when
 * the time ran out first, leaving `work` to finish on its own. The timer is cleared either way.
 */
export function within(work: Promise<unknown>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), Math.max(0, ms));
    const settled = () => {
      clearTimeout(timer);
      resolve(true);
    };
    work.then(settled, settled);
  });
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}
