import type { Capabilities, FeatureFlags } from './types';

/**
 * Which pages a deployment's answer closes. A page is one of three kinds: always there, there
 * unless the server lists a concept as `hidden` (it exists only for a Qelay TCP server or a local
 * agent), or there only when its feature is switched on. A page may also be for operators only:
 * its whole purpose is to change things, so a viewer is told so rather than shown a dead form.
 */
interface Gate {
  readonly paths: readonly string[];
  readonly hidden?: string;
  readonly feature?: keyof FeatureFlags;
  /** The page exists to mutate. The server still refuses a viewer; this is only the courtesy. */
  readonly operator?: true;
  /** Said on the page that replaces it. */
  readonly name: string;
}

const GATES: readonly Gate[] = [
  { paths: ['/server'], hidden: 'serverControl', name: 'Server control' },
  { paths: ['/database'], hidden: 'sqliteDatabase', name: 'The SQLite database browser' },
  { paths: ['/s3', '/s3-classic'], hidden: 's3Backup', name: 'S3 backup' },
  { paths: ['/fleet'], hidden: 'fleet', name: 'Fleet' },
  { paths: ['/flows'], feature: 'flows', name: 'Job flows' },
  { paths: ['/workflows'], feature: 'workflows', name: 'Workflows' },
  { paths: ['/webhooks'], feature: 'webhooks', operator: true, name: 'Webhooks' },
  { paths: ['/cron', '/cron-classic', '/cron-manager'], feature: 'cron', name: 'Cron jobs' },
  {
    paths: ['/dlq-control'],
    feature: 'dlq',
    operator: true,
    name: 'DLQ control',
  },
  {
    paths: ['/dlq', '/dlq-classic'],
    feature: 'dlq',
    name: 'The dead letter queue',
  },
  {
    paths: ['/add-job', '/jobs/bulk-add', '/queue-control', '/benchmark'],
    operator: true,
    name: 'This page',
  },
];

const under = (pathname: string, path: string): boolean =>
  pathname === path || pathname.startsWith(`${path}/`);

function gateFor(pathname: string): Gate | undefined {
  const clean = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  return GATES.find((gate) => gate.paths.some((path) => under(clean, path)));
}

function open(gate: Gate, caps: Capabilities): boolean {
  if (gate.hidden !== undefined && caps.hidden.includes(gate.hidden)) return false;
  if (gate.feature !== undefined && !caps.features[gate.feature]) return false;
  return true;
}

const operatorBlocked = (gate: Gate, caps: Capabilities): boolean =>
  gate.operator === true && !mayOperate(caps);

/** The page is one a deployment can close, so it waits for the server's answer before it shows. */
export const isGatedPage = (pathname: string): boolean => gateFor(pathname) !== undefined;

/** Whether the page at `pathname` (relative to the router's base) is served here. */
export function isPageAvailable(pathname: string, caps: Capabilities): boolean {
  const gate = gateFor(pathname);
  return gate === undefined || (open(gate, caps) && !operatorBlocked(gate, caps));
}

/** The page is served here but is for operators, and the caller is a viewer. */
export function needsOperator(pathname: string, caps: Capabilities): boolean {
  const gate = gateFor(pathname);
  return gate !== undefined && open(gate, caps) && operatorBlocked(gate, caps);
}

/** The name of the closed feature behind `pathname`, for the "not available" page. */
export function closedFeatureName(pathname: string, caps: Capabilities): string | null {
  const gate = gateFor(pathname);
  return gate && !open(gate, caps) ? gate.name : null;
}

/** Actions the server closes (`not_supported`): a control for one is left out, not shown failing. */
export const isActionSupported = (caps: Capabilities, action: string): boolean =>
  !caps.unsupported.includes(action);

/**
 * A part of a page that needs a server concept (the local control agent's queue operations) and is
 * listed as `hidden` by the deployment. Left out of the page, not shown failing.
 */
export const isConceptHidden = (caps: Capabilities, name: string): boolean =>
  caps.hidden.includes(name);

/** The caller's own role. A control the viewer may not use is left out; the server still refuses it. */
export const mayOperate = (caps: Capabilities): boolean => caps.principal.role === 'operator';
