import type { ExecutionState } from '@qelay-cloud/core';
import type { AsyncCommand } from 'fast-check';
import type { Act, Outcome } from './compare';
import { both, verifyWorkflows } from './compare';
import type { WorkflowWorld } from './world';

/** The runs a history works on: few enough that commands keep meeting the same ones. */
export const IDS = ['e0', 'e1', 'e2', 'e3'] as const;
export const NAMES = ['order', 'refund'] as const;
export const EVENTS = ['a', 'b'] as const;
export const STATES: readonly ExecutionState[] = [
  'running',
  'running',
  'waiting',
  'completed',
  'completed',
  'failed',
  'compensating',
  'compensation-stuck',
];

/** The command's name is what comes before its arguments: the planted bugs key on it. */
const nameOf = (label: string): string => label.slice(0, label.indexOf('('));

/** The rule an outcome reached, for the coverage report. */
type Rule = (outcome: Outcome) => string | undefined;

/**
 * One step of a history: the same operation on the Postgres store and on the reference, their answers
 * compared, then the whole store checked. Every command is always applicable: one aimed at a run that
 * does not exist is a call with an unknown id, which the stores must also answer alike.
 */
export class Op implements AsyncCommand<object, WorkflowWorld> {
  constructor(
    private readonly label: string,
    private readonly act: Act,
    private readonly rule: Rule = () => undefined
  ) {}

  check(): boolean {
    return true;
  }

  async run(_model: object, world: WorkflowWorld): Promise<void> {
    const outcome = await both(world, this.label, this.act);
    world.hit(this.rule(outcome));
    await world.planted?.after?.(world, nameOf(this.label));
    await verifyWorkflows(world);
  }

  toString(): string {
    return this.label;
  }
}

export const valueOf = (outcome: Outcome): Record<string, unknown> =>
  outcome.ok ? ((outcome.value ?? {}) as Record<string, unknown>) : {};

export const errorHas = (outcome: Outcome, text: string): boolean =>
  !outcome.ok && outcome.error.includes(text);
