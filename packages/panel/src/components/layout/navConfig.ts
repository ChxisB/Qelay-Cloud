import { matchPath } from 'react-router-dom';
import { ICON } from './NavIcon';

export type NavItemDef = {
  to: string;
  label: string;
  icon: string;
  end?: boolean;
  /** Other pages that are this item too (a kind switch on one page): the item is current on each. */
  also?: readonly string[];
};

/** Every path an item stands for, its own first. */
export const navPaths = (item: NavItemDef): readonly string[] => [item.to, ...(item.also ?? [])];
/** Whether `pathname` is a page the item stands for; `NavLink` cannot say it for `also`. */
export const isNavCurrent = (item: NavItemDef, pathname: string): boolean =>
  navPaths(item).some((path) => matchPath({ path, end: item.end ?? false }, pathname));
/** The four reports of the Health item: each is its own page, switched by `HealthTabs`. */
export const HEALTH_TABS = [
  { to: '/deployment', label: 'Deployment' },
  { to: '/diagnostics', label: 'Diagnostics' },
  { to: '/transport', label: 'Job delivery' },
  { to: '/usage', label: 'Usage' },
] as const;

/** The seven screens of the Event gateway item: each is its own page, switched by `GatewayTabs`. */
export const GATEWAY_TABS = [
  { to: '/events-gateway', label: 'Connections' },
  { to: '/events-gateway/sources', label: 'Sources' },
  { to: '/events-gateway/requests', label: 'Requests' },
  { to: '/events-gateway/events', label: 'Events' },
  { to: '/events-gateway/metrics', label: 'Metrics' },
  { to: '/events-gateway/issues', label: 'Issues' },
  { to: '/events-gateway/destinations', label: 'Destinations' },
] as const;

/** The six pages of the System item: each is its own page, switched by `SystemTabs`. */
export const SYSTEM_TABS = [
  { to: '/server', label: 'Server' },
  { to: '/database', label: 'Database' },
  { to: '/s3', label: 'Backups' },
  { to: '/mcp', label: 'MCP' },
  { to: '/benchmark', label: 'Benchmark' },
  { to: '/fleet', label: 'Fleet' },
] as const;

export type NavGroupDef = { section: string | null; items: NavItemDef[] };

// The single source of truth for the app's navigation. The sidebar, the breadcrumb and the
// command palette (Cmd/Ctrl-K) all read it, so a new section shows up in each automatically.
// Labels and icons are the design's; `icon` is path data from `NavIcon`.
export const NAV: NavGroupDef[] = [
  {
    section: null,
    items: [{ to: '/', label: 'Home', icon: ICON.grid, end: true }],
  },
  {
    section: 'Work',
    items: [
      // Exact matching prevents Queues + a queue detail from being announced as the current page at the same time.
      { to: '/queues', label: 'Queues', icon: ICON.queues, end: true },
      // Add job, Bulk add and the job inspector are reached from the Jobs page; they are Jobs.
      {
        to: '/jobs',
        also: ['/add-job', '/jobs/bulk-add', '/job'],
        label: 'Jobs',
        icon: ICON.jobs,
        end: true,
      },
      { to: '/dlq', label: 'Dead letter queue', icon: ICON.dlq },
      { to: '/cron', label: 'Cron jobs', icon: ICON.cron },
    ],
  },
  {
    section: 'Automation',
    items: [
      // Webhooks, workflows' triggers and queue-to-queue routes are one gateway: seven screens on one item.
      {
        to: GATEWAY_TABS[0].to,
        // A connection's own page (`/connections/:id` and its tabs) is part of the item too.
        also: [...GATEWAY_TABS.slice(1).map((tab) => tab.to), '/events-gateway/connections/*'],
        label: 'Event gateway',
        icon: ICON.webhooks,
        end: true,
      },
      // Job flows and workflow runs are two engines and one idea: the page has a switch between them.
      { to: '/flows', also: ['/workflows'], label: 'Flows', icon: ICON.flows, end: true },
    ],
  },
  {
    section: 'Monitor',
    items: [
      { to: '/metrics', label: 'Metrics', icon: ICON.metrics },
      { to: '/workers', label: 'Workers', icon: ICON.workers },
      { to: '/logs', label: 'Logs', icon: ICON.logs },
      { to: '/alerts', label: 'Alerts', icon: ICON.alerts },
      {
        to: HEALTH_TABS[0].to,
        also: HEALTH_TABS.slice(1).map((tab) => tab.to),
        label: 'Health',
        icon: ICON.diagnostics,
      },
    ],
  },
  {
    section: 'System',
    items: [
      { to: '/settings', label: 'Settings', icon: ICON.settings },
      {
        to: SYSTEM_TABS[0].to,
        also: SYSTEM_TABS.slice(1).map((tab) => tab.to),
        label: 'System',
        icon: ICON.server,
      },
    ],
  },
];

/**
 * `NAV` as this deployment serves it: an item whose page is closed is left out, and a group with no
 * item left goes with it. An item with several pages is kept while one is open, and links to the first open one.
 * The sidebar and the command palette read this, never `NAV` itself.
 */
export function visibleNav(isAvailable: (pathname: string) => boolean): NavGroupDef[] {
  return NAV.map((group) => ({
    ...group,
    items: group.items.flatMap((item) => {
      const open = navPaths(item).find(isAvailable);
      return open === undefined ? [] : [{ ...item, to: open }];
    }),
  })).filter((group) => group.items.length > 0);
}

export type NavLocation = {
  /** Group heading, or null for the unlabelled root group. */
  section: string | null;
  /** The matching item's label, or null when the route is not a nav destination. */
  label: string | null;
};

/**
 * Which nav group (and item) a pathname belongs to. The most specific item wins, so
 * `/jobs/bulk-add` is not claimed by `/jobs`. A queue detail page
 * (`/queues/:name`) is not an item of its own but still lives under Work. Returns
 * null for routes outside the nav (404).
 */
export function locateNav(pathname: string): NavLocation | null {
  let best: { section: string | null; item: NavItemDef; length: number } | null = null;
  for (const group of NAV) {
    for (const item of group.items) {
      const end = item.end ?? false;
      const hit = navPaths(item).find((path) => matchPath({ path, end }, pathname));
      if (hit === undefined) continue;
      if (!best || hit.length > best.length) {
        best = { section: group.section, item, length: hit.length };
      }
    }
  }
  if (best) return { section: best.section, label: best.item.label };
  if (/^\/queues\/[^/]/i.test(pathname)) return { section: 'Work', label: null };
  return null;
}
