import { WORKFLOWS_SINCE_VERSION } from '@qelay-cloud/store-postgres';
import { within } from '../deadline';
import type { ControlApiDeps } from '../deps';
import { DEFAULT_FEATURES } from '../deps';
import type { Route } from '../http/router';
import type { CapabilitiesResponse, Role } from '../types';
import { HIDDEN_FEATURES, UNSUPPORTED_ACTIONS } from '../types';

/** The longest the schema probe may take before workflows are reported off. */
const SCHEMA_PROBE_MS = 2_000;

/**
 * Whether the workflow routes can answer: the jobs routes are served and the database has the
 * workflow store's tables (migration 10). A deployment that turns workflows off says so in
 * `features.workflows`, which wins. Without a schema probe the migrated store is taken as given. A
 * probe that fails or is slow reports off for this answer; the panel asks again on its next load.
 */
async function workflowsAvailable(deps: ControlApiDeps): Promise<boolean> {
  if (deps.jobs === undefined) return false;
  const probe = deps.readiness.schemaVersion;
  if (probe === undefined) return true;
  const current = await within(probe.call(deps.readiness), SCHEMA_PROBE_MS).catch(() => null);
  return current !== null && current >= WORKFLOWS_SINCE_VERSION;
}

/**
 * What the panel shows. The transport and the features are declared by the process that built them,
 * not detected here, so the answer is the configuration and cannot disagree with it. An unbounded
 * delay (`Infinity` in the transport's capabilities, which JSON cannot carry) is `null`. The role
 * is the caller's own; the route is not public, so a request that got here has one.
 */
export async function capabilities(
  deps: ControlApiDeps,
  version: string,
  role: Role
): Promise<CapabilitiesResponse> {
  const { transport } = deps;
  const delay = transport.capabilities.maxDeliverDelayMs;
  return {
    transport: {
      name: transport.name,
      maxDeliverDelayMs: Number.isFinite(delay) ? delay : null,
      ordering: transport.ordering ?? 'none',
    },
    // Flows and webhooks are on wherever the jobs routes are served: the store has them, and so do the routes.
    // Workflows also need the migrated tables, and a deployment can switch them off.
    features: {
      ...DEFAULT_FEATURES,
      flows: deps.jobs !== undefined,
      webhooks: deps.jobs !== undefined,
      workflows: deps.features?.workflows ?? (await workflowsAvailable(deps)),
      ...deps.features,
    },
    hidden: [...HIDDEN_FEATURES],
    unsupported: [...UNSUPPORTED_ACTIONS],
    principal: { role },
    version,
  };
}

export function capabilitiesRoutes(deps: ControlApiDeps, version: string): Route[] {
  return [
    {
      method: 'GET',
      path: '/capabilities',
      access: 'read',
      handle: ({ principal }) => capabilities(deps, version, principal?.role ?? 'viewer'),
    },
  ];
}
