import type { DeploymentView, StoreRow, TransportQueue } from './types';

/** The colour of a status dot or strip. `zinc` is "not known". */
export type Tone = 'green' | 'amber' | 'red' | 'zinc';

const RANK: Record<Tone, number> = { green: 0, zinc: 1, amber: 2, red: 3 };

/** The worse of two tones; unknown outranks healthy because not knowing is not "fine". */
export const worse = (a: Tone, b: Tone): Tone => (RANK[a] >= RANK[b] ? a : b);

/** A count that may be unknown. Never "0" for a number that was not read. */
export const figure = (value: number | null | undefined): string =>
  value === null || value === undefined ? 'unknown' : value.toLocaleString('en-US');

/**
 * A duration that may be unknown, in the two coarsest units that matter: "850ms", "12s", "5m",
 * "5m 30s", "2h 5m", "3d 4h". The ops pages deal in minutes and hours, which `formatDuration`
 * (built for job runtimes) would print as "125m 3s".
 */
export function span(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return 'unknown';
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  const seconds = Math.floor(ms / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return seconds % 60 === 0 ? `${minutes}m` : `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return hours % 24 === 0 ? `${days}d` : `${days}d ${hours % 24}h`;
}

/** "12s ago" for an age, "unknown" for none. Whole seconds under a minute, coarser above. */
export function ago(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return 'unknown';
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/**
 * How old a broker figure is, in words that do not imply real time: a cloud metric is minutes
 * behind by design, so a reading is "as of 45s ago, up to 5m behind".
 */
export function freshnessLabel(queue: TransportQueue): string {
  const { ageMs, maxStalenessMs, source } = queue.freshness;
  if (ageMs === null) return 'not read';
  const lag = maxStalenessMs > 0 ? `, up to ${span(maxStalenessMs)} behind` : '';
  return `${ago(ageMs)}${lag} · ${source}`;
}

export function tickTone(state: DeploymentView['tick']['state']): Tone {
  switch (state) {
    case 'ok':
      return 'green';
    case 'late':
      return 'amber';
    case 'stale':
    case 'never':
      return 'red';
    default:
      return 'zinc';
  }
}

/**
 * The one indicator on the Dashboard: how the doorbell path and its repair loop are doing. It is
 * about health, not configuration, so "the development token is on" does not colour it.
 */
export function stripTone(deployment: DeploymentView): Tone {
  let tone = tickTone(deployment.tick.state);
  if (deployment.database.state === 'failed') tone = worse(tone, 'red');
  if (deployment.database.state === 'unknown') tone = worse(tone, 'zinc');
  const overdue = deployment.warnings.find((warning) => warning.code === 'doorbells_overdue');
  if (overdue) tone = worse(tone, overdue.severity === 'critical' ? 'red' : 'amber');
  if (deployment.transport.state === 'failed') tone = worse(tone, 'amber');
  return tone;
}

/** The strip's one-word state, for people who cannot see its colour. */
export const TONE_WORD: Record<Tone, string> = {
  green: 'Healthy',
  amber: 'Falling behind',
  red: 'Needs attention',
  zinc: 'Unknown',
};

export type DoorbellVerdict =
  | { kind: 'unknown'; text: string }
  | { kind: 'ok'; text: string }
  | { kind: 'held'; text: string }
  | { kind: 'tick-behind'; text: string }
  | { kind: 'poison'; text: string }
  | { kind: 'backlog'; text: string };

/**
 * What a queue's numbers mean, in one sentence each. The two readings the page exists for: many
 * claimable jobs that were never rung (the tick is behind), and a deep dead-letter queue (poison
 * doorbells). A backlog of old-but-rung bells is the normal state of a queue with more jobs than
 * workers, so it is said plainly and is not an alarm.
 */
export function doorbellVerdict(queue: TransportQueue, lateAfterMs: number): DoorbellVerdict {
  const { store } = queue;
  if (store.paused) {
    return {
      kind: 'held',
      text: 'Paused: its jobs are held on purpose and the tick does not ring them.',
    };
  }
  if ((queue.deadLetterDepth ?? 0) > 0) {
    return {
      kind: 'poison',
      text: `${figure(queue.deadLetterDepth)} poison doorbell${queue.deadLetterDepth === 1 ? '' : 's'}: the broker gave up delivering them. The jobs stay in the database; redriving is a runbook step.`,
    };
  }
  if (store.notRung > 0 && (store.oldestNotRungAgeMs ?? 0) >= lateAfterMs) {
    return {
      kind: 'tick-behind',
      text: `${figure(store.notRung)} claimable job${store.notRung === 1 ? ' has' : 's have'} no doorbell, the oldest for ${span(store.oldestNotRungAgeMs)}: the tick is behind.`,
    };
  }
  if (store.notRung > 0) {
    return {
      kind: 'ok',
      text: `${figure(store.notRung)} claimable job${store.notRung === 1 ? '' : 's'} waiting for the next tick to ring them.`,
    };
  }
  if (store.reRingDue > 0) {
    return {
      kind: 'backlog',
      text: 'More jobs than workers: older doorbells are still waiting at the broker and the tick rings them again. Normal for a backlog.',
    };
  }
  if (queue.doorbellDepth === null && queue.deadLetterDepth === null) {
    return { kind: 'unknown', text: 'The broker did not answer: its numbers are unknown.' };
  }
  return { kind: 'ok', text: 'Nothing waiting for a doorbell.' };
}

/** Tone of a queue's verdict, for its row. */
export const verdictTone = (verdict: DoorbellVerdict): Tone =>
  ({
    ok: 'green',
    held: 'zinc',
    unknown: 'zinc',
    backlog: 'zinc',
    'tick-behind': 'amber',
    poison: 'red',
  })[verdict.kind] as Tone;

/** The store's claimable count, with "or more" when the count stopped at its cap. */
export const claimableLabel = (row: StoreRow): string =>
  `${figure(row.claimable)}${row.capped ? '+' : ''}`;
