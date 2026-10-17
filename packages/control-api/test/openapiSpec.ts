import { join } from 'node:path';

const SPEC = join(import.meta.dir, '../../../docs/openapi.yaml');

export interface Operation {
  security?: unknown[];
  responses: Record<string, unknown>;
}

export interface Schema {
  required?: string[];
  properties?: Record<string, unknown>;
  additionalProperties?: unknown;
}

export interface Spec {
  openapi: string;
  security: unknown[];
  paths: Record<string, Record<string, Operation>>;
  components: Record<string, Record<string, unknown>>;
}

export const spec = Bun.YAML.parse(await Bun.file(SPEC).text()) as Spec;

/** `METHOD /path` of every operation the document describes, in the spec's `{name}` spelling. */
export const documented = (): string[] =>
  Object.entries(spec.paths).flatMap(([path, item]) =>
    Object.keys(item).map((method) => `${method.toUpperCase()} ${path}`)
  );

/** A router path in the spec's spelling: `:name` is `{name}` and a trailing `*` is `{path}`. */
export const asSpecPath = (path: string): string =>
  path.replace(/:([A-Za-z]\w*)/g, '{$1}').replace(/\/\*$/, '/{path}');

/** Every `$ref` in the document, so a typo is found here and not by a client generator. */
export function refs(node: unknown, found: string[] = []): string[] {
  if (Array.isArray(node)) for (const item of node) refs(item, found);
  else if (node !== null && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (key === '$ref' && typeof value === 'string') found.push(value);
      else refs(value, found);
    }
  }
  return found;
}

export const schema = (name: string): Schema => {
  const found = spec.components.schemas?.[name];
  if (found === undefined) throw new Error(`no schema ${name} in docs/openapi.yaml`);
  return found as Schema;
};

/**
 * Not a schema validator: it pins the top-level keys of an object to the schema's `properties` and
 * `required`, which is where a field added to the code and forgotten in the spec shows up.
 */
export function keysFit(body: unknown, name: string): string[] {
  const { required = [], properties = {} } = schema(name);
  const keys = Object.keys(body as Record<string, unknown>);
  const problems: string[] = [];
  for (const key of required) if (!keys.includes(key)) problems.push(`${name}: missing ${key}`);
  for (const key of keys) {
    if (!(key in properties)) problems.push(`${name}: undocumented ${key}`);
  }
  return problems;
}
