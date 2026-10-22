import type { WorkflowFanOut, WorkflowStep } from './workflowWire';

/**
 * What the server leaves of a value past its size budget: a marker in place of the value. The panel
 * says so beside it; it never shows the cut value as if it were whole.
 */
export interface TruncatedMarker {
  readonly $type: 'truncated';
  readonly kind: string;
  readonly length: number;
  readonly preview?: string;
  readonly maxBytes: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const isTruncatedMarker = (value: unknown): value is TruncatedMarker =>
  isRecord(value) && value.$type === 'truncated';

/** Whether a marker sits anywhere in the value (a payload is cut at the level that went over). */
export function containsTruncation(value: unknown, depth = 0): boolean {
  if (isTruncatedMarker(value)) return true;
  if (depth > 12) return false;
  if (Array.isArray(value)) return value.some((item) => containsTruncation(item, depth + 1));
  if (isRecord(value))
    return Object.values(value).some((item) => containsTruncation(item, depth + 1));
  return false;
}

export function describeMarker(marker: TruncatedMarker): string {
  return `Cut at ${marker.maxBytes.toLocaleString('en-US')} bytes: a ${marker.kind} of ${marker.length.toLocaleString('en-US')}`;
}

/** A value as the panel prints it: indented JSON; a value the server tagged keeps its tag. */
export function printValue(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? 'null';
  } catch {
    return String(value);
  }
}

/** Whether there is anything to print: `null`, nothing and an empty object say nothing. */
export const hasValue = (value: unknown): boolean =>
  !(value === undefined || value === null || (isRecord(value) && Object.keys(value).length === 0));

/** A fan-out's counts in one line, the state with the most attention first. */
export function fanOutSummary(fanOut: WorkflowFanOut): string {
  const { byStatus } = fanOut;
  const parts = [
    byStatus.failed > 0 ? `${byStatus.failed.toLocaleString('en-US')} failed` : null,
    byStatus.running > 0 ? `${byStatus.running.toLocaleString('en-US')} running` : null,
    byStatus.pending > 0 ? `${byStatus.pending.toLocaleString('en-US')} pending` : null,
    `${byStatus.completed.toLocaleString('en-US')} completed`,
  ];
  return parts.filter(Boolean).join(' · ');
}

/** A step with iterations is shown as one row with counts, and its iterations on request. */
export const isFanOut = (step: WorkflowStep): step is WorkflowStep & { fanOut: WorkflowFanOut } =>
  step.fanOut !== undefined;

/** How a graph node reads in a list: its kind, then what sets it apart. */
export interface NodeDescription {
  kind: string;
  detail: string;
  steps: string[];
}

const stepNames = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.flatMap((entry) =>
        isRecord(entry) && typeof entry.name === 'string' ? [entry.name] : []
      )
    : [];

const stepName = (value: unknown): string[] =>
  isRecord(value) && typeof value.name === 'string' ? [value.name] : [];

const seconds = (ms: unknown): string =>
  typeof ms === 'number' ? `${ms >= 1000 ? Math.round(ms / 100) / 10 : ms / 1000}s` : 'none';

export function describeNode(node: Record<string, unknown>): NodeDescription {
  const kind = typeof node.type === 'string' ? node.type : 'node';
  switch (kind) {
    case 'step': {
      const step = isRecord(node.step) ? node.step : {};
      const flags = [
        typeof step.retry === 'number' && step.retry > 0 ? `${step.retry} retries` : null,
        typeof step.timeout === 'number' ? `timeout ${seconds(step.timeout)}` : null,
        step.compensates === true ? 'can be rolled back' : null,
      ].filter(Boolean);
      return { kind, detail: flags.join(' · '), steps: stepName(step) };
    }
    case 'waitFor':
      return {
        kind,
        detail: `waits for "${String(node.event)}"${node.timeout == null ? '' : `, up to ${seconds(node.timeout)}`}`,
        steps: [],
      };
    case 'branch': {
      const paths = Array.isArray(node.paths) ? node.paths.filter(isRecord) : [];
      return {
        kind,
        detail: `${paths.length} paths`,
        steps: paths.map(
          (path) => `${String(path.name)}: ${stepNames(path.steps).join(', ') || '—'}`
        ),
      };
    }
    case 'parallel':
      return { kind, detail: 'steps run together', steps: stepNames(node.steps) };
    case 'subWorkflow':
      return { kind, detail: `runs "${String(node.name)}"`, steps: [] };
    case 'doUntil':
    case 'doWhile':
      return {
        kind,
        detail: `at most ${String(node.maxIterations)} rounds`,
        steps: stepNames(node.steps),
      };
    case 'forEach':
      return {
        kind,
        detail: `at most ${String(node.maxIterations)} items`,
        steps: stepName(node.step),
      };
    case 'map':
      return { kind, detail: `transforms into "${String(node.name)}"`, steps: [] };
    case 'pivot':
      return {
        kind,
        detail: 'point of no return: once passed, the run is no longer rolled back',
        steps: [],
      };
    default:
      return { kind, detail: '', steps: [] };
  }
}

/** Every step name a graph node holds, as a plain list (`describeNode().steps` words a branch for reading). */
export function nodeStepNames(node: Record<string, unknown>): string[] {
  switch (node.type) {
    case 'step':
    case 'forEach':
      return stepName(node.step);
    case 'parallel':
    case 'doUntil':
    case 'doWhile':
      return stepNames(node.steps);
    case 'branch':
      return (Array.isArray(node.paths) ? node.paths.filter(isRecord) : []).flatMap((path) =>
        stepNames(path.steps)
      );
    default:
      return [];
  }
}

const LIVE = new Set(['running', 'waiting', 'compensating', 'compensation-stuck']);

/** The run is still going, or waits for an operator: it has a place in its definition. */
export const isLiveState = (state: string): boolean => LIVE.has(state);
