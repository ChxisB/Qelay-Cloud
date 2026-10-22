import { type ReactNode, useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/cn';
import { Button } from './Button';
import { copyText } from './CopyButton';
import { StatusGlyph } from './StatusBadge';

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

// Skeleton blocks keep the layout still while data arrives. `motion-safe` so reduced motion draws them flat.
const SKELETON = 'block h-3.5 rounded-[8px] bg-slate-tint motion-safe:animate-pulse';
const SKELETON_ROWS = ['w-[90%]', 'w-[70%]', 'w-[82%]', 'w-[58%]'];

/** The label is announced, not drawn: sighted users get the skeleton, which is what the boards show. */
export function LoadingState({ label = 'Loading…' }: { label?: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      aria-busy="true"
      className="flex flex-col gap-3 py-6"
    >
      <span className="sr-only">{label}</span>
      <div aria-hidden="true" className="flex flex-col">
        {SKELETON_ROWS.map((width) => (
          <div
            key={width}
            className="grid grid-cols-[2fr_1fr_1fr_1fr] gap-4 border-b border-line py-3.5 last:border-b-0"
          >
            <span className={cn(SKELETON, width)} />
            <span className={SKELETON} />
            <span className={SKELETON} />
            <span className={SKELETON} />
          </div>
        ))}
      </div>
    </div>
  );
}

/** The round icon badge the States board puts above an empty or failed state. */
function StateBadge({ children, danger }: { children: ReactNode; danger?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'grid size-14 place-items-center rounded-full [&>svg]:size-[26px]',
        danger ? 'bg-danger-tint text-danger' : 'bg-slate-tint text-muted'
      )}
    >
      {children}
    </span>
  );
}

const TITLE = 'm-0 text-lg font-bold leading-tight tracking-[-0.02em] text-fg';

/** A page-level state is the page's h1, an in-card one stays plain text, as before. */
function StateTitle({ level, children }: { level?: 1 | 2 | 3; children: ReactNode }) {
  const Tag = level ? (`h${level}` as const) : 'div';
  return <Tag className={TITLE}>{children}</Tag>;
}

export function EmptyState({
  icon,
  picture,
  code,
  title,
  hint,
  action,
  headingLevel,
}: {
  icon?: ReactNode;
  /** A larger drawing that teaches what the empty page is for (see `illustrations.tsx`), in place of the icon. */
  picture?: ReactNode;
  /** A large decorative numeral in place of the icon, for the 404 page. */
  code?: string;
  title: string;
  hint?: string;
  action?: ReactNode;
  headingLevel?: 1 | 2 | 3;
}) {
  return (
    <div className="motion-arrive flex flex-col items-center justify-center gap-2.5 rounded-card border border-dashed border-line px-4 py-8 text-center">
      {icon && !picture && <StateBadge>{icon}</StateBadge>}
      {picture && (
        <span aria-hidden="true" className="text-muted [&>svg]:h-20 [&>svg]:w-32">
          {picture}
        </span>
      )}
      {code && (
        <p
          aria-hidden="true"
          className="m-0 text-[32px] font-bold leading-none tracking-[-0.05em] text-faint"
        >
          {code}
        </p>
      )}
      <StateTitle level={headingLevel}>{title}</StateTitle>
      {hint && <div className="max-w-[420px] text-sm text-muted">{hint}</div>}
      {action && <div className="mt-1.5 flex flex-wrap justify-center gap-3">{action}</div>}
    </div>
  );
}

/**
 * Non-blocking "not connected" strip, the board's live strip in its slow or disconnected
 * state. Shown at the top of a page when the qelay server is unreachable (or running
 * embedded with no HTTP surface) so the page can keep a last-known snapshot without
 * presenting it as live. Not full-page, and the glyph and the word carry the state.
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
      className="motion-arrive mb-4 flex flex-wrap items-center gap-3 rounded-[18px] border border-line bg-surface px-4 py-3 text-sm"
    >
      <span className="inline-flex items-center gap-2 font-bold text-state-waiting-fg">
        <StatusGlyph state="waiting" />
        Disconnected
      </span>
      <span className="min-w-0 flex-1 basis-64 text-muted">{message}</span>
      {onRetry && (
        <Button size="sm" onClick={onRetry} className="ml-auto">
          Retry
        </Button>
      )}
    </div>
  );
}

/** The request facts an error already carries, never its `details` (which may echo server data). */
function errorDetails(error: Error): string {
  const { status, code } = error as { status?: unknown; code?: unknown };
  return [
    error.message,
    typeof status === 'number' && `status ${status}`,
    typeof code === 'string' && `code ${code}`,
  ]
    .filter(Boolean)
    .join('\n');
}

export function ErrorState({
  error,
  onRetry,
  title = 'Something went wrong',
  headingLevel,
}: {
  error: Error;
  onRetry?: () => void;
  title?: string;
  headingLevel?: 1 | 2 | 3;
}) {
  const [copy, setCopy] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    []
  );
  const copyDetails = async () => {
    setCopy((await copyText(errorDetails(error))) ? 'copied' : 'failed');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopy('idle'), 1500);
  };

  return (
    <div
      role="alert"
      aria-atomic="true"
      className="motion-arrive flex flex-col items-center justify-center gap-2.5 rounded-card border border-danger/20 bg-danger-tint/40 px-4 py-8 text-center"
    >
      <StateBadge danger>
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M12 3l10 18H2zM12 10v5M12 18.5v.5" />
        </svg>
      </StateBadge>
      <StateTitle level={headingLevel}>{title}</StateTitle>
      <div className="max-w-[420px] text-sm text-muted">{error.message}</div>
      <div className="mt-1.5 flex flex-wrap justify-center gap-3">
        {onRetry && (
          <Button variant="primary" size="sm" onClick={onRetry}>
            Retry
          </Button>
        )}
        <Button size="sm" onClick={copyDetails}>
          {copy === 'copied' ? 'Copied' : copy === 'failed' ? 'Copy failed' : 'Copy details'}
        </Button>
      </div>
    </div>
  );
}
