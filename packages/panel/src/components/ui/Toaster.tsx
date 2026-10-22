import { useEffect } from 'react';
import { type Toast, useToastStore } from '@/components/dashboard/stores/toastStore';
import { cn } from '@/lib/cn';
import { useLeavers } from '@/lib/useLeavers';
import { IconButton } from './Button';
import { IconClose } from './icons';
import { StatusGlyph, type StateRole } from './StatusBadge';

// The glyph says what happened, the title says it in words; neither relies on colour alone.
const LEVEL_ROLE: Record<Toast['level'], StateRole> = {
  success: 'completed',
  error: 'failed',
  info: 'active',
};

function ToastCard({
  toast,
  leaving,
  dismiss,
}: {
  toast: Toast;
  leaving: boolean;
  dismiss: (id: number) => void;
}) {
  // Depend on the stable store `dismiss` + this toast's id/ttl — NOT a freshly
  // built closure — so an unrelated toast being added/removed doesn't reset this
  // one's auto-dismiss timer.
  useEffect(() => {
    if (leaving) return;
    const t = window.setTimeout(() => dismiss(toast.id), toast.ttlMs);
    return () => window.clearTimeout(t);
  }, [toast.id, toast.ttlMs, dismiss, leaving]);

  return (
    <div
      role={toast.level === 'error' ? 'alert' : 'status'}
      // A toast on its way out can no longer be reached or clicked.
      inert={leaving || undefined}
      className={cn(
        'flex w-[420px] max-w-[calc(100vw-2rem)] items-center gap-3 rounded-[18px] border border-line-strong bg-surface-2 py-3.5 pl-4 pr-2.5 shadow-pop',
        leaving ? 'motion-leave pointer-events-none' : 'motion-arrive pointer-events-auto'
      )}
    >
      <StatusGlyph state={LEVEL_ROLE[toast.level]} />
      <div className="min-w-0 flex-1 font-bold text-fg">
        {toast.title}
        {toast.detail && (
          <small className="block break-words text-[13px] font-medium text-muted">
            {toast.detail}
          </small>
        )}
      </div>
      <IconButton
        size="sm"
        variant="ghost"
        onClick={() => dismiss(toast.id)}
        aria-label="Dismiss notification"
      >
        <IconClose className="size-4" />
      </IconButton>
    </div>
  );
}

/**
 * Fixed bottom-right toast stack. Mounted once in AppLayout; reads the toast
 * store so any page (or non-React helper) can raise durable feedback.
 */
export function Toaster() {
  const toasts = useToastStore((s) => s.toasts);
  const dismiss = useToastStore((s) => s.dismiss);
  const rows = useLeavers(toasts);
  // The live region stays mounted even when empty: screen readers generally
  // ignore content inserted together with a brand-new live region, so the
  // first toast would otherwise go unannounced.
  return (
    <section
      className="pointer-events-none fixed bottom-4 right-4 z-[60] flex flex-col gap-2"
      aria-label="Notifications"
      aria-live="polite"
    >
      {rows.map(({ item, leaving }) => (
        <ToastCard key={item.id} toast={item} leaving={leaving} dismiss={dismiss} />
      ))}
    </section>
  );
}
