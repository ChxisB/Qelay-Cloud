import type { ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { ErrorState, LoadingState } from '@/components/ui/feedback';
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

  if (status === 'loading') return <LoadingState label="Checking what this deployment offers…" />;
  if (status === 'error') {
    return (
      <ErrorState
        headingLevel={1}
        title="This page could not be opened"
        error={new Error(`The server did not say what it offers. ${error ?? ''}`.trim())}
        onRetry={onRetry}
      />
    );
  }
  const closed = closedFeatureName(pathname, caps);
  if (closed !== null) return <NotAvailable name={closed} />;
  if (needsOperator(pathname, caps)) return <OperatorOnly />;
  return <>{children}</>;
}
