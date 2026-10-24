import type { QueueRunWindow, QueueRunWindowInput, QueueRunWindowState } from '@qelay-cloud/core';
import { UnsupportedOptionError, validateRunWindow } from '@qelay-cloud/core';
import type { StoreContext } from './context';
import { identifier } from './prepare';
import { lockQueueState } from './queueState';
import { runTransaction } from './retry';
import { jsonOrNull } from './webhookRows';
import { checkSchedule, nextFire } from './webhookSchedule';

/**
 * A queue's run window (DESIGN.md D17): the claim reads `window_from` and `window_until`, two integers, and starts
 * nothing outside them. The interval is the one that contains now or the next one to open; the tick moves it on when it
 * has ended, and a saved window is given its first interval here. Nothing else reads the cron.
 */

interface Interval {
  readonly from: number;
  readonly until: number;
}

/** The first window whose end is after `now`: the one that is open, or the next. */
export function intervalFor(window: QueueRunWindow, now: number): Interval {
  const from = nextFire(window, now - window.durationMs + 1);
  if (from === 0) throw new UnsupportedOptionError('runWindow', 'the cron never fires');
  // shortcut: a duration longer than the gap between two fires closes the window for up to one tick at the end of each
  // interval; the next one is already open by then. Upgrade by chaining overlapping intervals if that matters.
  return { from, until: from + window.durationMs };
}

const stateOf = (window: QueueRunWindow, at: Interval, now: number): QueueRunWindowState => ({
  ...window,
  open: at.from <= now && now < at.until,
  opensAt: at.from,
  closesAt: at.until,
});

/** The queue's window and where it stands, or null when it has none (a queue never used included). */
export async function getRunWindow(
  ctx: StoreContext,
  name: string
): Promise<QueueRunWindowState | null> {
  const queue = identifier('queue', name);
  return ctx.db.run('getRunWindow', async (sql) => {
    const now = await ctx.db.time.now(sql);
    const [row] = await sql<
      Array<{
        run_window: unknown;
        window_from: number | string | bigint;
        window_until: number | string | bigint;
      }>
    >`
      SELECT run_window, window_from, window_until FROM qcloud_queue_state
      WHERE namespace = ${ctx.namespace} AND queue = ${queue} AND run_window IS NOT NULL`;
    if (row === undefined) return null;
    const at = { from: Number(row.window_from), until: Number(row.window_until) };
    return stateOf(validateRunWindow(jsonOrNull<unknown>(row.run_window)), at, now);
  });
}

/**
 * Replaces the queue's window, or with `null` removes it. The cron must parse and fire at least once every 31 days.
 * The queue's jobs keep their place: a window saved while the queue is closed holds what is waiting until it opens, and
 * removing one lets the next tick ring what it held. Returns the window as stored.
 */
export async function setRunWindow(
  ctx: StoreContext,
  name: string,
  window: QueueRunWindowInput | null
): Promise<QueueRunWindowState | null> {
  const queue = identifier('queue', name);
  const valid = window === null ? null : validateRunWindow(window);
  if (valid !== null) checkSchedule(valid, 'runWindow');
  return ctx.db.run('setRunWindow', (sql) =>
    runTransaction(sql, async (tx) => {
      await lockQueueState(tx, ctx.namespace, queue, true);
      const now = await ctx.db.time.now(tx);
      const at = valid === null ? null : intervalFor(valid, now);
      await tx`
        UPDATE qcloud_queue_state
        SET run_window = ${valid === null ? null : JSON.stringify(valid)}::text::jsonb,
            window_from = ${at?.from ?? null}, window_until = ${at?.until ?? null}
        WHERE namespace = ${ctx.namespace} AND queue = ${queue}`;
      return valid === null || at === null ? null : stateOf(valid, at, now);
    })
  );
}

/**
 * The tick's step: moves the interval of every queue whose window has ended on to the next one. At most `maxItems` per
 * call, the ones that ended longest ago first, taken `FOR UPDATE SKIP LOCKED` so two ticks do not both do one. A tick
 * that was down moves it straight to the window that contains now, so it opens when the tick returns. A window whose
 * cron cannot be read is left as it is: the queue stays closed, and one bad row does not stop the tick.
 */
export async function advanceWindows(
  ctx: StoreContext,
  maxItems: number
): Promise<{ readonly advanced: number; readonly more: boolean }> {
  return ctx.db.run('advanceWindows', (sql) =>
    runTransaction(sql, async (tx) => {
      const now = await ctx.db.time.now(tx);
      const ended = await tx<Array<{ queue: string; run_window: unknown }>>`
        SELECT queue, run_window FROM qcloud_queue_state
        WHERE namespace = ${ctx.namespace} AND run_window IS NOT NULL AND window_until <= ${now}
        ORDER BY window_until LIMIT ${maxItems}
        FOR UPDATE SKIP LOCKED`;
      let advanced = 0;
      for (const row of ended) {
        let at: Interval;
        try {
          at = intervalFor(validateRunWindow(jsonOrNull<unknown>(row.run_window)), now);
        } catch {
          continue;
        }
        await tx`
          UPDATE qcloud_queue_state SET window_from = ${at.from}, window_until = ${at.until}
          WHERE namespace = ${ctx.namespace} AND queue = ${row.queue}`;
        advanced += 1;
      }
      return { advanced, more: ended.length >= maxItems };
    })
  );
}
