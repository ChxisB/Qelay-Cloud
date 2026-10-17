/**
 * Readers for a plan of `infra/aws/example`: the IAM policy documents a plan carries as JSON strings, the
 * actions each may name, and the references of a root module call. The plan model itself (`Plan`, `get`,
 * `Checks`) is shared with the GCP check.
 */
import type { Plan, ResourceChange } from './terraform-plan-model';
import { after, get } from './terraform-plan-model';

export interface Statement {
  readonly Sid?: string;
  readonly Effect: string;
  readonly Action?: string | readonly string[];
  readonly NotAction?: unknown;
  readonly Resource?: string | readonly string[];
  readonly Principal?: unknown;
  readonly Condition?: Record<string, Record<string, unknown>>;
}

/** What a policy that Terraform cannot know until apply looks like to a check. */
export type Policy = { readonly known: true; readonly statements: readonly Statement[] } | { known: false };

export const sorted = (values: readonly string[]) => [...values].sort();
export const same = (a: readonly string[], b: readonly string[]) =>
  JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));

export const list = (value: string | readonly string[] | undefined): readonly string[] =>
  value === undefined ? [] : typeof value === 'string' ? [value] : value;

/** The statements of the policy JSON in `field` of a resource: unknown when the plan has no value for it. */
export function policyOf(change: ResourceChange, field = 'policy'): Policy {
  const raw = get(after(change), field);
  if (typeof raw !== 'string') return { known: false };
  const parsed = JSON.parse(raw) as { Statement: Statement | Statement[] };
  return {
    known: true,
    statements: Array.isArray(parsed.Statement) ? parsed.Statement : [parsed.Statement],
  };
}

/** What a root-module call is passed for `argument`: the addresses its expression refers to. */
export function callReferences(plan: Plan, call: string, argument: string): readonly string[] {
  const expressions = get(plan.configuration.root_module, 'module_calls', call, 'expressions');
  const references = get(expressions, argument, 'references');
  return Array.isArray(references) ? references.map(String) : [];
}

/** The plain environment a process is told, from the example's `processes` output. */
export function processEnvironment(plan: Plan, ...path: Array<string>): Record<string, string> {
  const found = get(plan.output_changes.processes, 'after', ...path, 'environment');
  return (found ?? {}) as Record<string, string>;
}

export const processOutput = (plan: Plan): unknown => get(plan.output_changes.processes, 'after');
