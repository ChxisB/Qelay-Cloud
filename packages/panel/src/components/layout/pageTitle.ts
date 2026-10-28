import { useEffect } from 'react';

const TITLES: Record<string, string> = {
  '/': 'Home',
  '/fleet': 'Fleet',
  '/queues': 'Queues',
  '/jobs': 'Jobs',
  '/dlq': 'Dead Letter Queue',
  '/cron': 'Cron Jobs',
  '/flows': 'Flows',
  '/workflows': 'Workflows',
  '/metrics': 'Metrics',
  '/workers': 'Workers',
  '/logs': 'Logs',
  '/server': 'Server',
  '/add-job': 'Add Job',
  '/jobs/bulk-add': 'Bulk Add Jobs',
  '/job': 'Job Inspector',
  '/events-gateway': 'Event gateway',
  '/events-gateway/sources': 'Gateway sources',
  '/events-gateway/requests': 'Gateway requests',
  '/events-gateway/events': 'Gateway events',
  '/events-gateway/metrics': 'Gateway metrics',
  '/events-gateway/issues': 'Gateway issues',
  '/events-gateway/destinations': 'Gateway destinations',
  '/events-gateway/connections/new': 'New connection',
  '/diagnostics': 'Diagnostics',
  '/alerts': 'Alerts',
  '/transport': 'Job delivery',
  '/deployment': 'Deployment',
  '/backups': 'Backups',
  '/benchmark': 'Benchmark',
  '/database': 'Database',
  '/mcp': 'MCP',
  '/usage': 'Usage',
  '/settings': 'Settings',
};

export function titleFor(pathname: string): string {
  const normalized = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  // React Router matches paths case-insensitively, so `/Settings` renders the
  // Settings page; resolve its title the same way (queue names keep their case).
  const lower = normalized.toLowerCase();
  if (TITLES[lower]) return TITLES[lower];
  if (/^\/events-gateway\/connections\/[^/]+(\/(metrics|settings))?$/.test(lower))
    return 'Gateway connection';
  if (lower.startsWith('/queues/')) {
    // A pasted/hand-typed URL may carry a malformed percent-escape (e.g. `%zz`),
    // which makes decodeURIComponent throw during render. Fall back to the raw slice.
    let name = normalized.slice('/queues/'.length);
    try {
      name = decodeURIComponent(name);
    } catch {}
    return `${name} · Queue`;
  }
  return 'Page not found';
}

export function useDocumentTitle(pageTitle: string): void {
  useEffect(() => {
    document.title = `${pageTitle} · Qelay Cloud`;
  }, [pageTitle]);
}
