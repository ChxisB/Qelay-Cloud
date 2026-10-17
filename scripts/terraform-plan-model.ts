/**
 * The shape of a `terraform show -json` plan, and the small readers the plan assertions share: a tolerant
 * `get` (plan JSON nests every block in a list), the references of a module's configuration, and `Checks`,
 * which collects every failure instead of stopping at the first.
 */
export interface ResourceChange {
  readonly address: string;
  readonly type: string;
  readonly name: string;
  readonly change: {
    readonly actions: readonly string[];
    readonly after: unknown;
    /** The attributes whose value the plan cannot know yet, as `true` leaves. */
    readonly after_unknown?: unknown;
  };
}

interface ConfigModule {
  readonly resources?: ReadonlyArray<{ readonly address: string; readonly expressions?: unknown }>;
  readonly module_calls?: Readonly<Record<string, { readonly module: ConfigModule }>>;
}

export interface Plan {
  readonly resource_changes: readonly ResourceChange[];
  readonly output_changes: Readonly<Record<string, { readonly after: unknown }>>;
  readonly configuration: { readonly root_module: ConfigModule };
}

/** The roles this configuration grants. Anything else, and every primitive role, is a failure. */
export const ALLOWED_ROLES: ReadonlySet<string> = new Set([
  'roles/pubsub.publisher',
  'roles/pubsub.subscriber',
  'roles/secretmanager.secretAccessor',
  'roles/run.invoker',
  'roles/iam.serviceAccountUser',
]);

export class Checks {
  passed = 0;
  readonly failures: string[] = [];

  ok(name: string, condition: boolean, detail = ''): void {
    if (condition) {
      this.passed += 1;
    } else {
      this.failures.push(detail === '' ? name : `${name}: ${detail}`);
    }
  }
}

/** Reads `value[path[0]][path[1]]...`, or undefined where a step is missing: plan JSON nests every block in a list. */
export function get(value: unknown, ...path: ReadonlyArray<string | number>): unknown {
  return path.reduce<unknown>(
    (at, key) =>
      at !== null && typeof at === 'object'
        ? (at as Record<string | number, unknown>)[key]
        : undefined,
    value
  );
}

export const after = (change: ResourceChange): unknown => change.change.after;

/** One attribute of a resource after the change, or undefined when the resource or the attribute is not there. */
export const attr = (change: ResourceChange | undefined, ...path: ReadonlyArray<string | number>) =>
  get(change?.change.after, ...path);

/** True when the plan has no value for the attribute yet, because the apply will make it. */
export const isUnknown = (change: ResourceChange | undefined, ...path: ReadonlyArray<string | number>) =>
  get(change?.change.after_unknown, ...path) === true;

/** The references of one expression of a resource in a child module's configuration. */
export function referencesOf(
  plan: Plan,
  module: string,
  resource: string,
  ...path: ReadonlyArray<string | number>
): readonly string[] {
  const config = plan.configuration.root_module.module_calls?.[module]?.module;
  const found = config?.resources?.find((candidate) => candidate.address === resource);
  const references = get(found?.expressions, ...path, 'references');
  return Array.isArray(references) ? references.map(String) : [];
}
export const ofType = (plan: Plan, type: string) =>
  plan.resource_changes.filter((c) => c.type === type);

export function envValue(service: ResourceChange, name: string): string | undefined {
  const env = get(after(service), 'template', 0, 'containers', 0, 'env');
  if (!Array.isArray(env)) return undefined;
  const found = env.find((entry: unknown) => get(entry, 'name') === name);
  const value = get(found, 'value');
  return typeof value === 'string' ? value : undefined;
}
