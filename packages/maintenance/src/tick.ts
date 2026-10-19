import type { DeliveryTransport } from '@qelay-cloud/core';
import type { PostgresStore } from '@qelay-cloud/store-postgres';
import type { TickConfig } from './config';
import type { RingStepReport } from './ring';
import { ringDue } from './ring';
import type { Telemetry } from './telemetry';
import { guarded, noTelemetry } from './telemetry';
import type { WebhookSending, WebhookStepReport } from './webhookSender';
import { addWebhooks, NO_WEBHOOKS, sendDueWebhooks } from './webhookSender';
import type { WorkflowStepReport, WorkflowSweepConfig } from './workflowSweep';
import { addWorkflows, NO_WORKFLOWS, sweepWorkflows } from './workflowSweep';

export interface TickDeps {
  readonly store: PostgresStore;
  readonly transport: Pick<DeliveryTransport, 'ring' | 'capabilities'>;
  readonly telemetry?: Telemetry;
  /** Sends due webhook deliveries after the ring step. Absent: the tick sends none. */
  readonly webhooks?: WebhookSending;
  /** Expires overdue waits and takes stuck runs after the ring step. Absent: the tick does neither. */
  readonly workflows?: WorkflowSweepConfig;
}

/** One pass, as counts only: nothing here names a job, a queue or a payload. */
export interface PassReport {
  readonly recovered: number;
  readonly promoted: number;
  readonly cronFired: number;
  readonly expired: number;
  /** A step was skipped or hit its batch size: another pass would find more to do. */
  readonly moreWork: boolean;
  /** Milliseconds per step of the store's tick, as `TickReport.stepMs` has them. */
  readonly stepMs: Readonly<Record<string, number>>;
  readonly ring: RingStepReport;
  readonly webhooks: WebhookStepReport;
  readonly workflows: WorkflowStepReport;
}

/** What one invocation did, summed over its passes. Safe to return to a caller: counts only. */
export interface RunReport {
  readonly passes: number;
  readonly recovered: number;
  readonly promoted: number;
  readonly cronFired: number;
  readonly expired: number;
  readonly ring: RingStepReport;
  readonly webhooks: WebhookStepReport;
  readonly workflows: WorkflowStepReport;
  /** The budget ran out while there was still more to do; the next invocation continues. */
  readonly moreWork: boolean;
  readonly durationMs: number;
  /**
   * Every pass ran to the end, every bell the store asked for reached the broker and was
   * recorded, and the webhook sender and the workflow step could reach the store. A receiver that
   * fails is not a failed tick. This is what `qcloud_tick_state` calls a success.
   */
  readonly ok: boolean;
}

const NO_RINGS: RingStepReport = {
  due: 0,
  rung: 0,
  deferred: 0,
  rejected: 0,
  unreachable: 0,
  unmarked: 0,
  skipped: 0,
};

function addRings(a: RingStepReport, b: RingStepReport): RingStepReport {
  return {
    due: a.due + b.due,
    rung: a.rung + b.rung,
    deferred: a.deferred + b.deferred,
    rejected: a.rejected + b.rejected,
    unreachable: a.unreachable + b.unreachable,
    unmarked: a.unmarked + b.unmarked,
    skipped: a.skipped + b.skipped,
  };
}

/** Bells the store asked for that did not end up rung and recorded, for a reason other than being left for later. */
function ringFailures(ring: RingStepReport): number {
  return ring.deferred + ring.rejected + ring.unreachable + ring.unmarked;
}

/**
 * The lifetime completed and failed counts, as gauges: a rising `jobs.failed_total` is the dead-letter
 * queue growing. One read of a few rows; a failed read is reported and leaves the pass as it was.
 */
async function jobTotals(
  store: PostgresStore,
  telemetry: Telemetry
): Promise<Array<[string, number]>> {
  try {
    const { completed, failed } = await store.metrics.totals();
    return [
      ['jobs.completed_total', completed],
      ['jobs.failed_total', failed],
    ];
  } catch (error) {
    telemetry.error('totals', error);
    return [];
  }
}

/**
 * One pass: the store's tick (recovery, crons, promotion, expiry, retention and the ring query,
 * all on the database's clock), then the ring step for what it asked for, then the workflow step
 * and the webhook step when configured. Throws what the store's tick throws; the other steps never
 * throw.
 */
export async function runTick(deps: TickDeps, config: TickConfig): Promise<PassReport> {
  const telemetry = guarded(deps.telemetry ?? noTelemetry);
  const started = performance.now();
  const report = await deps.store.tick(config.budget);
  const stored = await ringDue(
    { store: deps.store, transport: deps.transport, telemetry },
    report.rings
  );
  const swept =
    deps.workflows === undefined
      ? { ...NO_WORKFLOWS, ring: NO_RINGS, moreWork: false }
      : await sweepWorkflows(
          { store: deps.store, transport: deps.transport, telemetry },
          deps.workflows
        );
  const ring = addRings(stored, swept.ring);
  const sent =
    deps.webhooks === undefined
      ? { ...NO_WEBHOOKS, moreWork: false }
      : await sendDueWebhooks(deps.store, deps.webhooks, telemetry);
  const totals = await jobTotals(deps.store, telemetry);
  const stepMs = report.stepMs ?? {};
  for (const [step, ms] of Object.entries(stepMs)) telemetry.duration(step, ms);
  telemetry.duration('pass', Math.round(performance.now() - started));
  const gauges: Array<[string, number]> = [
    ['recovered', report.recovered],
    ['promoted', report.promoted],
    ['cron_fired', report.cronFired],
    ['expired', report.expired],
    ['rings.due', ring.due],
    ['rings.rung', ring.rung],
    ['rings.deferred', ring.deferred],
    ['rings.rejected', ring.rejected],
    ['rings.unreachable', ring.unreachable],
    ['rings.unmarked', ring.unmarked],
    ['rings.skipped', ring.skipped],
    ['workflows.due', swept.due],
    ['workflows.recovered', swept.recovered],
    ['workflows.errors', swept.errors],
    ['webhooks.claimed', sent.claimed],
    ['webhooks.delivered', sent.delivered],
    ['webhooks.retrying', sent.retrying],
    ['webhooks.failed', sent.failed],
    ['webhooks.stale', sent.stale],
    ['webhooks.paused', sent.paused],
    ['webhooks.errors', sent.errors],
    ...totals,
    ['more_work', report.moreWork || swept.moreWork || sent.moreWork ? 1 : 0],
    // Last, and the same test as the report's `ok`: an alert on a pass that did not finish its work.
    ['ok', ringFailures(ring) === 0 && swept.errors === 0 && sent.errors === 0 ? 1 : 0],
  ];
  for (const [name, value] of gauges) telemetry.gauge(name, value);
  return {
    recovered: report.recovered,
    promoted: report.promoted,
    cronFired: report.cronFired,
    expired: report.expired,
    moreWork: report.moreWork || swept.moreWork || sent.moreWork,
    stepMs,
    workflows: { due: swept.due, recovered: swept.recovered, errors: swept.errors },
    ring,
    webhooks: {
      claimed: sent.claimed,
      delivered: sent.delivered,
      retrying: sent.retrying,
      failed: sent.failed,
      stale: sent.stale,
      paused: sent.paused,
      errors: sent.errors,
    },
  };
}

/**
 * One invocation: passes repeat while the last one reported more work, until `maxRunMs` of
 * wall-clock time is spent, so a backlog drains without waiting for the next scheduler call. At
 * least one pass always runs. The outcome is recorded for `tickStatus` (the "last successful tick"
 * the panel shows and the alerts read), and a failed pass is recorded and rethrown.
 *
 * A pass is a database round trip per step, not a long transaction: the budget is checked between
 * passes, so an invocation can overrun `maxRunMs` by one pass (itself bounded by `maxPassMs` plus
 * the ring step).
 */
export async function runTicks(deps: TickDeps, config: TickConfig): Promise<RunReport> {
  const telemetry = guarded(deps.telemetry ?? noTelemetry);
  const started = performance.now();
  let passes = 0;
  let totals = { recovered: 0, promoted: 0, cronFired: 0, expired: 0 };
  let ring = NO_RINGS;
  let webhooks = NO_WEBHOOKS;
  let workflows = NO_WORKFLOWS;
  let moreWork = false;
  try {
    do {
      const pass = await runTick(deps, config);
      passes += 1;
      totals = {
        recovered: totals.recovered + pass.recovered,
        promoted: totals.promoted + pass.promoted,
        cronFired: totals.cronFired + pass.cronFired,
        expired: totals.expired + pass.expired,
      };
      ring = addRings(ring, pass.ring);
      webhooks = addWebhooks(webhooks, pass.webhooks);
      workflows = addWorkflows(workflows, pass.workflows);
      moreWork = pass.moreWork;
      // A broker that is down or a store that cannot record would fail every pass the same way.
      if (ringFailures(pass.ring) > 0 || pass.webhooks.errors > 0 || pass.workflows.errors > 0)
        break;
    } while (moreWork && performance.now() - started < config.maxRunMs);
  } catch (error) {
    telemetry.error('tick', error);
    await record(deps, telemetry, false);
    throw error;
  }
  const ok = ringFailures(ring) === 0 && webhooks.errors === 0 && workflows.errors === 0;
  await record(deps, telemetry, ok);
  return {
    passes,
    ...totals,
    ring,
    webhooks,
    workflows,
    moreWork,
    durationMs: Math.round(performance.now() - started),
    ok,
  };
}

async function record(deps: TickDeps, telemetry: Telemetry, ok: boolean): Promise<void> {
  try {
    await deps.store.maintenance.recordTick(ok);
  } catch (error) {
    telemetry.error('record', error);
  }
}
