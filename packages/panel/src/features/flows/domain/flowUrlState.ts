/** The part of the Flows page an address names: which flow, and which job of it is selected. */
export interface FlowUrlState {
  root: string;
  node: string | null;
}

export type FlowUrlPatch = Partial<FlowUrlState>;

const MAX_ID_LENGTH = 1024;

/** Why `id` cannot name a job in a request path, or null when it can. */
export function flowIdError(id: string): string | null {
  if (id.trim().length === 0) return 'Job ID must not be empty';
  if (id.length > MAX_ID_LENGTH) return `Job ID must be ${MAX_ID_LENGTH} characters or fewer`;
  if (id === '.' || id === '..') {
    return 'Job ID must not be "." or ".." because URL parsers treat it as a path traversal segment';
  }
  return null;
}

const valid = (value: string | null): value is string =>
  value !== null && flowIdError(value) === null;

export function readFlowUrlState(params: URLSearchParams): FlowUrlState {
  const rawRoot = params.get('root');
  const root = valid(rawRoot) ? rawRoot : '';
  const rawNode = params.get('node');
  return { root, node: root && valid(rawNode) ? rawNode : null };
}

export function flowSearchParams(value: FlowUrlState): URLSearchParams {
  const params = new URLSearchParams();
  if (value.root) params.set('root', value.root);
  if (value.root && value.node) params.set('node', value.node);
  return params;
}

export function patchFlowSearchParams(
  params: URLSearchParams,
  patch: FlowUrlPatch
): URLSearchParams {
  return flowSearchParams({ ...readFlowUrlState(params), ...patch });
}

/** The Flows page address for the flow rooted at `root`, with `node` selected. */
export function flowHref(root: string, node: string | null = null): string {
  const query = flowSearchParams({ root, node: node === root ? null : node }).toString();
  return query ? `/flows?${query}` : '/flows';
}
