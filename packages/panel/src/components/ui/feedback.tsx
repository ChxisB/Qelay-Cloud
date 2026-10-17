import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { Button } from './Button';

export function Spinner({
  className,
  decorative = false,
}: {
  className?: string;
  decorative?: boolean;
}) {
  const spinnerClassName = cn(
    'inline-block size-4 animate-spin rounded-full border-2 border-current border-t-transparent',
    className
  );
  if (decorative) {
    return <span className={spinnerClassName} aria-hidden="true" />;
  }
  return <span className={spinnerClassName} role="status" aria-label="Loading" />;
}

export function LoadingState({ label = 'Loading…' }: { label?: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className="flex items-center justify-center gap-3 py-16 text-sm text-muted"
    >
      <Spinner decorative />
      {label}
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  hint,
  action,
}: {
  icon?: ReactNode;
  title: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-card border border-dashed border-line py-14 text-center">
      {icon && <div className="text-faint [&>svg]:size-8">{icon}</div>}
      <div className="text-sm font-medium text-fg">{title}</div>
      {hint && <div className="max-w-sm text-xs text-faint">{hint}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

/**
 * Subtle, non-blocking "not connected" notice. Shown at the top of a page when
 * the qelay server is unreachable (or running embedded with no HTTP surface)
 * so the page can retain a last-known snapshot without presenting it as live.
 * Not red, not full-page — just an amber hint that data is unavailable/stale.
 */
export function OfflineBanner({
  onRetry,
  message = 'Could not refresh server data — the view may be unavailable or stale.',
}: {
  onRetry?: () => void;
  /** Override when the unreachable thing isn't the qelay server (e.g. the control agent). */
  message?: string;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className="mb-4 flex flex-wrap items-center gap-3 rounded-control border border-warning/25 bg-warning/[0.06] px-4 py-2.5 text-sm"
    >
      <span className="size-2 shrink-0 rounded-full bg-warning" aria-hidden="true" />
      <span className="text-warning">{message}</span>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="ml-auto shrink-0 rounded-md border border-warning/30 px-2.5 py-1 text-xs font-medium text-warning hover:border-warning/60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          Retry
        </button>
      )}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: Error; onRetry?: () => void }) {
  return (
    <div
      role="alert"
      aria-atomic="true"
      className="flex flex-col items-center justify-center gap-3 rounded-card border border-danger/20 bg-danger/5 py-14 text-center"
    >
      <div className="text-sm font-medium text-danger">Something went wrong</div>
      <div className="max-w-md text-xs text-faint">{error.message}</div>
      {onRetry && (
        <Button size="sm" onClick={onRetry} className="mt-1">
          Retry
        </Button>
      )}
    </div>
  );
}
