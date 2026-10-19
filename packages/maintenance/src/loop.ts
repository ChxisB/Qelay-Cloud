import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { UnsupportedOptionError } from '@qelay-cloud/core';
import type { TickConfig, TickOptions } from './config';
import { resolveTickConfig } from './config';
import { guarded, noTelemetry } from './telemetry';
import type { RunReport, TickDeps } from './tick';
import { runTicks } from './tick';

export interface TickLoopOptions extends TickOptions {
  /** Names this process in the lease row. Default: host, pid and a random suffix, unique per loop. */
  readonly holder?: string;
  /**
   * How long a lease lasts after each renewal, in database time. At least twice the interval, so
   * one late beat does not hand the lead over. Default: three intervals.
   */
  readonly leaseMs?: number;
}

/** What a loop has done, for tests and for an operator's log line. */
export interface LoopStats {
  readonly beats: number;
  /** Beats that held the lease and ran a tick. */
  readonly led: number;
  /** Beats that found another process leading. */
  readonly followed: number;
  readonly failed: number;
}

/**
 * The opt-in in-process tick: every interval, ask for the leader lease, and run the tick if it is
 * ours. The lease is one row compared against the database clock (see `acquireTickLease`), renewed
 * by the same call each interval, so a leader that dies is replaced about one lease length later.
 *
 * The lease only saves work. The tick is safe to run from several processes at once, so a process
 * that runs it without the lease (a pause longer than the lease, a clock fault, a stale answer)
 * costs repeated work and nothing else. That is also why a beat that finds the database down just
 * logs and waits for the next one: it never has to decide whether it still leads.
 *
 * Timers are a chain, not an interval: the next beat is scheduled for the previous beat's
 * scheduled time plus one interval, so a slow beat does not stack and a busy event loop catches up
 * rather than drifting. A tick that overruns its interval delays the next beat; it never overlaps
 * with itself inside one loop.
 */
export class TickLoop {
  readonly holder: string;
  readonly config: TickConfig;
  readonly leaseMs: number;
  readonly #deps: TickDeps;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #running: Promise<void> | null = null;
  #stopped = true;
  #leading = false;
  #next = 0;
  /** When this process last ran the upkeep steps, 0 for never. Per process, not shared by the lease. */
  #upkeptAt = 0;
  #stats = { beats: 0, led: 0, followed: 0, failed: 0 };

  constructor(deps: TickDeps, options: TickLoopOptions = {}) {
    this.#deps = deps;
    this.config = resolveTickConfig(deps.transport, options, deps.store);
    this.holder =
      options.holder ?? `${hostname()}:${process.pid}:${randomBytes(4).toString('hex')}`;
    if (this.holder === '') throw new UnsupportedOptionError('holder', 'must not be empty');
    const leaseMs = options.leaseMs ?? 3 * this.config.intervalMs;
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 2 * this.config.intervalMs) {
      throw new UnsupportedOptionError(
        'leaseMs',
        `is ${leaseMs}, below two tick intervals (${2 * this.config.intervalMs}): one late beat would hand the lead over`
      );
    }
    this.leaseMs = leaseMs;
  }

  /** Whether the last beat held the lease. A hint: the lease can expire the moment after. */
  get leading(): boolean {
    return this.#leading;
  }

  get stats(): LoopStats {
    return { ...this.#stats };
  }

  /** Starts beating. The first beat is immediate. Idempotent. */
  start(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    this.#next = performance.now();
    this.#schedule();
  }

  /**
   * Stops beating, waits for the beat in flight (up to `timeout`, default 10,000 ms) and gives the
   * lease up, so a follower takes over on its next beat instead of after the lease runs out. In a
   * worker's shutdown this goes after the jobs are released and before the transport closes: the
   * last beat may still ring.
   */
  async stop(options: { readonly timeout?: number } = {}): Promise<void> {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    const running = this.#running;
    if (running) {
      const timeout = options.timeout ?? 10_000;
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        running,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, timeout);
        }),
      ]);
      clearTimeout(timer);
    }
    if (this.#leading) {
      this.#leading = false;
      try {
        await this.#deps.store.maintenance.releaseTickLease(this.holder);
      } catch (error) {
        guarded(this.#deps.telemetry ?? noTelemetry).error('loop', error);
      }
    }
  }

  /**
   * One beat now: renew or take the lease, and run the tick if it is ours. Returns the report, or
   * null when another process leads or the beat failed. Never throws. The timer calls this; tests
   * and a caller with its own schedule may too.
   */
  async beat(): Promise<RunReport | null> {
    const telemetry = guarded(this.#deps.telemetry ?? noTelemetry);
    this.#stats.beats += 1;
    try {
      const lease = await this.#deps.store.maintenance.acquireTickLease(this.holder, this.leaseMs);
      this.#leading = lease.held;
      if (!lease.held) {
        this.#stats.followed += 1;
        return null;
      }
      this.#stats.led += 1;
      // One beat never runs past its interval: what is left waits for the next one.
      const now = performance.now();
      const { upkeepEveryMs } = this.config;
      const skipUpkeep =
        upkeepEveryMs > 0 && this.#upkeptAt !== 0 && now - this.#upkeptAt < upkeepEveryMs;
      const config = {
        ...this.config,
        maxRunMs: Math.min(this.config.maxRunMs, this.config.intervalMs),
        budget: skipUpkeep ? { ...this.config.budget, skipUpkeep } : this.config.budget,
      };
      const report = await runTicks(this.#deps, config);
      if (!skipUpkeep) this.#upkeptAt = now;
      return report;
    } catch (error) {
      this.#stats.failed += 1;
      telemetry.error('loop', error);
      return null;
    }
  }

  #schedule(): void {
    if (this.#stopped) return;
    const wait = Math.max(0, this.#next - performance.now());
    this.#timer = setTimeout(() => {
      this.#timer = null;
      const run = this.beat().then(() => {
        this.#running = null;
        const now = performance.now();
        this.#next += this.config.intervalMs;
        // Behind by a whole interval or more: skip the missed beats instead of firing them in a burst.
        if (this.#next <= now - this.config.intervalMs) this.#next = now;
        this.#schedule();
      });
      this.#running = run;
    }, wait);
  }
}
