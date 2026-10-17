/**
 * What the tick tells the outside. It has no cloud dependency: the adapters (OpenTelemetry, Cloud
 * Monitoring, CloudWatch) are written against this interface, and each prefixes the names with
 * `qcloud.tick.`.
 */
export interface Telemetry {
  /**
   * How long a step took, in ms. `step` is `pass` (the whole of one pass), one of the store's steps
   * (`recover`, `crons`, `promote`, `expire`, `retention`, `events`, `completions`, `ringQuery`),
   * `ring` (the transport) or `mark` (`markRung`).
   */
  duration(step: string, ms: number): void;
  /**
   * A count or a size at the end of a pass: `recovered`, `promoted`, `cron_fired`, `expired`,
   * `rings.due`, `rings.rung`, `rings.deferred`, `rings.rejected`, `rings.unreachable`,
   * `rings.unmarked`, `rings.skipped`, `jobs.completed_total` and `jobs.failed_total` (lifetime counts of every queue; the latter
   * rising is the dead-letter queue growing), `more_work` (0 or 1), and `ok` (1 when no bell failed to be rung and recorded and neither
   * the workflow nor the webhook step errored, else 0; the last gauge of a pass).
   */
  gauge(name: string, value: number): void;
  /** Something failed. `step` says where: `tick`, `ring`, `mark`, `record`, `totals`, `loop` or `http`. */
  error(step: string, error: unknown): void;
}

export const noTelemetry: Telemetry = {
  duration() {},
  gauge() {},
  error() {},
};

/** A sink that throws must not take the tick down with it: every call is guarded. */
export function guarded(telemetry: Telemetry): Telemetry {
  const guard =
    <A extends unknown[]>(call: (...args: A) => void) =>
    (...args: A): void => {
      try {
        call(...args);
      } catch {
        // A broken sink is the sink's problem.
      }
    };
  return {
    duration: guard((step, ms) => telemetry.duration(step, ms)),
    gauge: guard((name, value) => telemetry.gauge(name, value)),
    error: guard((step, error) => telemetry.error(step, error)),
  };
}
