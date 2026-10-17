import type { Execution, StepRecord, StepState } from '@qelay-cloud/core';
import { LOOP_ITERATION_SUFFIX, loopBaseName } from '@qelay-cloud/core';
import type { Wire } from './payload';
import { toWire } from './payload';

/**
 * The step records of a run as the panel reads them. A fan-out (a `forEach`, a `map`, a loop body)
 * leaves one record per iteration, named `<step>:<n>`, next to a record of the step itself that
 * mirrors the latest one. A run over 10,000 items has more than 10,000 records, so the list shows
 * the step once with counts (`fanOut`) and the iterations are read a page at a time
 * (`iterationOf`). Nothing here grows with the number of records except one pass over them.
 */

export interface FanOut {
  readonly iterations: number;
  readonly byStatus: Readonly<Record<StepState, number>>;
  readonly compensation: {
    readonly compensated: number;
    readonly failed: number;
    readonly skipped: number;
  };
}

export interface StepWire {
  readonly name: string;
  readonly status: StepState;
  readonly attempts: number | null;
  readonly startedAt: number | null;
  readonly completedAt: number | null;
  readonly durationMs: number | null;
  readonly compensatable: boolean;
  readonly error: string | null;
  readonly errorTruncated?: true;
  /** Present when the record holds a result; `resultTruncated` says it was cut to the byte budget. */
  readonly result?: Wire;
  readonly resultTruncated?: true;
  readonly childExecutionId: string | null;
  readonly compensation: {
    readonly status: string;
    readonly at: number;
    readonly error: string | null;
  } | null;
  readonly loopIndex: number | null;
  readonly loopItem?: Wire;
  readonly loopItemTruncated?: true;
  readonly fanOut?: FanOut;
}

export interface StepsPage {
  readonly items: StepWire[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
  readonly hasMore: boolean;
}

export interface StepsSelector {
  readonly iterationOf?: string | undefined;
  readonly name?: string | undefined;
  readonly status?: StepState | undefined;
  readonly limit: number;
  readonly offset: number;
}

export interface PayloadBudgets {
  readonly listBytes: number;
  readonly detailBytes: number;
}

type Entry = readonly [name: string, record: StepRecord];

/** Characters of an error kept in a response. */
const MAX_ERROR_CHARS = 2_000;

export interface StepIndex {
  /** The records the run is read by: every one that is not an iteration of another, in the order they started. */
  readonly top: Entry[];
  /** The iterations of each fan-out step, by the step's name, in iteration order. */
  readonly groups: ReadonlyMap<string, Entry[]>;
  readonly all: Entry[];
}

const startOf = (entry: Entry): number => entry[1].startedAt ?? Number.POSITIVE_INFINITY;
const byStart = (a: Entry, b: Entry): number => {
  const left = startOf(a);
  const right = startOf(b);
  return left === right ? 0 : left < right ? -1 : 1;
};

const iterationNumber = (entry: Entry): number =>
  entry[1].loopIndex ?? Number(/:(\d+)$/.exec(entry[0])?.[1] ?? 0);

export function indexSteps(steps: Execution['steps']): StepIndex {
  const all = Object.entries(steps);
  const names = new Set(all.map(([name]) => name));
  const top: Entry[] = [];
  const groups = new Map<string, Entry[]>();
  for (const entry of all) {
    const base = loopBaseName(entry[0]);
    if (base !== entry[0] && LOOP_ITERATION_SUFFIX.test(entry[0]) && names.has(base)) {
      const group = groups.get(base);
      if (group === undefined) groups.set(base, [entry]);
      else group.push(entry);
    } else {
      top.push(entry);
    }
  }
  // `Array.prototype.sort` is stable, so records that have not started keep the order they were made in.
  top.sort(byStart);
  for (const group of groups.values())
    group.sort((a, b) => iterationNumber(a) - iterationNumber(b));
  return { top, groups, all };
}

function clip(text: string | undefined): { error: string | null; errorTruncated?: true } {
  if (text === undefined) return { error: null };
  if (text.length <= MAX_ERROR_CHARS) return { error: text };
  return { error: text.slice(0, MAX_ERROR_CHARS), errorTruncated: true };
}

export function clipText(text: string | undefined, max: number): string | null {
  if (text === undefined) return null;
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

export function fanOutOf(group: readonly Entry[]): FanOut {
  const byStatus: Record<StepState, number> = { pending: 0, running: 0, completed: 0, failed: 0 };
  const compensation = { compensated: 0, failed: 0, skipped: 0 };
  for (const [, record] of group) {
    byStatus[record.status] += 1;
    const outcome = record.compensation?.status;
    if (outcome === 'compensated') compensation.compensated += 1;
    else if (outcome === 'compensation-failed') compensation.failed += 1;
    else if (outcome === 'compensation-skipped') compensation.skipped += 1;
  }
  return { iterations: group.length, byStatus, compensation };
}

export function stepWire(
  [name, record]: Entry,
  maxBytes: number,
  fanOut?: readonly Entry[]
): StepWire {
  const result = record.result !== undefined ? toWire(record.result, { maxBytes }) : null;
  const item = record.loopItem !== undefined ? toWire(record.loopItem, { maxBytes }) : null;
  return {
    name,
    status: record.status,
    attempts: record.attempts ?? null,
    startedAt: record.startedAt ?? null,
    completedAt: record.completedAt ?? null,
    durationMs:
      record.startedAt !== undefined && record.completedAt !== undefined
        ? Math.max(0, record.completedAt - record.startedAt)
        : null,
    compensatable: record.compensatable === true,
    ...clip(record.error),
    ...(result === null
      ? {}
      : { result: result.value, ...(result.truncated ? { resultTruncated: true as const } : {}) }),
    childExecutionId: record.childExecutionId ?? null,
    compensation:
      record.compensation === undefined
        ? null
        : {
            status: record.compensation.status,
            at: record.compensation.at,
            error: clipText(record.compensation.error, MAX_ERROR_CHARS),
          },
    loopIndex: record.loopIndex ?? null,
    ...(item === null
      ? {}
      : { loopItem: item.value, ...(item.truncated ? { loopItemTruncated: true as const } : {}) }),
    ...(fanOut === undefined ? {} : { fanOut: fanOutOf(fanOut) }),
  };
}

/** One page of the run's steps (or of one fan-out's iterations, or the one record `name`). */
export function stepsPage(
  index: StepIndex,
  steps: Execution['steps'],
  select: StepsSelector,
  budgets: PayloadBudgets
): StepsPage {
  let source: readonly Entry[];
  if (select.iterationOf !== undefined) source = index.groups.get(select.iterationOf) ?? [];
  else if (select.name !== undefined) {
    const record = Object.hasOwn(steps, select.name) ? steps[select.name] : undefined;
    source = record === undefined ? [] : [[select.name, record]];
  } else source = index.top;
  const matching =
    select.status === undefined
      ? source
      : source.filter(([, record]) => record.status === select.status);
  const maxBytes = select.name !== undefined ? budgets.detailBytes : budgets.listBytes;
  const items = matching
    .slice(select.offset, select.offset + select.limit)
    .map((entry) =>
      stepWire(
        entry,
        maxBytes,
        select.iterationOf === undefined ? index.groups.get(entry[0]) : undefined
      )
    );
  return {
    items,
    total: matching.length,
    limit: select.limit,
    offset: select.offset,
    hasMore: select.offset + items.length < matching.length,
  };
}
