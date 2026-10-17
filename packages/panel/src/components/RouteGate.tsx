import type { ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { closedFeatureName, isGatedPage, needsOperator } from '@/lib/capabilities/model';
import { useCapabilities } from '@/lib/capabilities/useCapabilities';
import { NotAvailable, OperatorOnly } from '@/pages/NotAvailable';

/**
 * Keeps a page that this deployment does not serve from rendering, whatever the URL says. A page
 * that can be closed waits for the server's answer; while it is loading or failed, it stays closed.
 * Pages that are always there are never held up by it.
 */
export function RouteGate({ children, onRetry }: { children: ReactNode; onRetry: () => void }) {
  const { pathname } = useLocation();
  const { status, error, caps } = useCapabilities();
  if (!isGatedPage(pathname)) return <>{children}</>;

  if (status === 'loading') {
    return (
      <div role="status" aria-busy="true" className="p-2 text-sm text-muted">
        Checking what this deployment offers…
      </div>
    );
  }
  if (status === 'error') {
    return (
      <div role="alert" className="flex flex-col items-start gap-3 p-2 text-sm">
        <p className="text-muted">
          This page could not be opened, because the server did not say what it offers.{' '}
          {error ?? ''}
        </p>
        <button
          type="button"
          onClick={onRetry}
          className="rounded-lg border border-line bg-surface-2 px-3 py-1.5 font-medium text-fg hover:border-line-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Retry
        </button>
      </div>
    );
  }
  const closed = closedFeatureName(pathname, caps);
  if (closed !== null) return <NotAvailable name={closed} />;
  if (needsOperator(pathname, caps)) return <OperatorOnly />;
  return <>{children}</>;
}
