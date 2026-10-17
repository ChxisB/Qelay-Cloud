// The places the panel decides what a response means, copied so a contract test can run the real
// logic on what the Control API sends (MIT, see docs/PORTING.md). Do not edit; delete with
// `panel-types.ts` when task 33 exists.
//
//   panel commit: 8ebf9328950a23a2f2687115a0ec15e66b7659bd (working tree, comment edits only)
//   `panelAcceptsHealth`: the checks of `fetchHealthWithTimeout` in src/pages/settings/health.ts
//   `panelReadinessProbe`: `readinessProbe` in src/pages/control/diagnostics/DiagnosticsPanels.tsx
//   (its `ProbeState` reduced to the label and the detail).
//   `parseQueueSummaryPayload`: the same-named function of src/lib/dashboardPayloads.ts, with its
//   helpers `record`, `text` and `count`.
import type { QueueSummaryFull } from './panel-bq-types';
import type { ReadinessResponse } from './panel-types';

const QELAY_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;

/** True when the panel's connection test accepts `value` as a health response. */
export function panelAcceptsHealth(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return !(
    typeof candidate.ok !== 'boolean' ||
    (candidate.status !== 'healthy' && candidate.status !== 'degraded') ||
    !Number.isSafeInteger(candidate.uptime) ||
    (candidate.uptime as number) < 0 ||
    typeof candidate.version !== 'string' ||
    !QELAY_VERSION.test(candidate.version) ||
    candidate.ok !== (candidate.status === 'healthy')
  );
}

export function panelReadinessProbe(
  value: ReadinessResponse | null,
  error: string | null = null
): { label: string; detail: string } {
  if (error) return { label: 'Unavailable', detail: error };
  if (!value) return { label: 'Unknown', detail: 'No response yet' };
  if (value.ok === true && value.ready === true) {
    return { label: 'Ready', detail: 'Persistence accepts traffic' };
  }
  if (value.ok === false && value.ready === false) {
    return {
      label: 'Not ready',
      detail: value.storage.error ?? 'Persistence is degraded',
    };
  }
  return { label: 'Unexpected', detail: 'Incoherent readiness payload' };
}

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

function text(value: unknown, max: number): value is string {
  if (typeof value !== 'string' || value.length > max || value.length === 0) return false;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) return false;
  }
  return true;
}

const count = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** `/queues/summary` is a bare array, so the panel validates it explicitly. */
export function parseQueueSummaryPayload(value: unknown): QueueSummaryFull[] {
  if (!Array.isArray(value)) {
    throw new Error('Malformed queue summary response.');
  }
  const names = new Set<string>();
  const summary: QueueSummaryFull[] = [];
  for (const candidate of value) {
    const queue = record(candidate);
    const counts = queue && record(queue.counts);
    if (
      !queue ||
      !text(queue.name, 256) ||
      names.has(queue.name) ||
      typeof queue.paused !== 'boolean' ||
      !counts ||
      !count(counts.waiting) ||
      !count(counts.prioritized) ||
      !count(counts.active) ||
      !count(counts.completed) ||
      !count(counts.failed) ||
      !count(counts.delayed)
    ) {
      throw new Error('Malformed queue summary response.');
    }
    names.add(queue.name);
    summary.push(candidate as QueueSummaryFull);
  }
  return summary;
}
