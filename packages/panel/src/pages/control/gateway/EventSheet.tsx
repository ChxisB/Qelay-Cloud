import { type ReactNode, useEffect, useRef } from 'react';
import {
  holdsModal,
  mayRestoreModalFocus,
  useGlobalModalStore,
} from '@/components/dashboard/stores/globalModalStore';
import { cn } from '@/lib/cn';

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/**
 * Claims the shell while the sheet is open (`open`), as every focus-trapping surface must. It calls `onLost` when
 * a higher-priority modal holds the shell, so closing that one cannot bring back a stale sheet.
 */
export function useSheetOwner(open: boolean, onLost: () => void) {
  const held = useGlobalModalStore(holdsModal('event-sheet'));
  useEffect(() => {
    const store = useGlobalModalStore.getState();
    if (!open) store.release('event-sheet');
    else if (!held && !store.request('event-sheet')) onLost();
  }, [open, held, onLost]);
  useEffect(
    () => () => {
      useGlobalModalStore.getState().release('event-sheet');
    },
    []
  );
}

/**
 * A panel that rises from the bottom edge over a scrim, for the windows too narrow for the side column. It traps
 * focus, closes with Escape, the scrim or the button inside, and gives focus back to what opened it. `leaving` is
 * the 180 ms of the exit: it no longer traps focus or answers a click.
 */
export function EventSheet({
  leaving,
  onClose,
  children,
}: {
  leaving: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });
  // A confirm over the sheet keeps it on screen but out of reach.
  const blocked = useGlobalModalStore((state) => state.active === 'confirm');

  useEffect(() => {
    if (leaving) return;
    const invoker = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    const focusables = () =>
      panel ? Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)) : [];
    const onKey = (event: KeyboardEvent) => {
      if (useGlobalModalStore.getState().active === 'confirm') return;
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const candidates = focusables();
      if (candidates.length === 0) {
        event.preventDefault();
        panel?.focus();
        return;
      }
      const active = document.activeElement as HTMLElement | null;
      const outside = !active || !panel?.contains(active);
      if (event.shiftKey && (active === candidates[0] || outside)) {
        event.preventDefault();
        candidates.at(-1)?.focus();
      } else if (!event.shiftKey && (active === candidates.at(-1) || outside)) {
        event.preventDefault();
        candidates[0].focus();
      }
    };
    const onFocus = (event: FocusEvent) => {
      if (useGlobalModalStore.getState().active === 'confirm') return;
      if (panel && !panel.contains(event.target as Node)) (focusables()[0] ?? panel).focus();
    };

    (focusables()[0] ?? panel)?.focus();
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('focusin', onFocus);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('focusin', onFocus);
      if (mayRestoreModalFocus('event-sheet') && invoker?.isConnected) invoker.focus();
    };
  }, [leaving]);

  return (
    <>
      <button
        type="button"
        aria-label="Close event"
        onClick={onClose}
        inert={blocked || undefined}
        className={cn(
          'fixed inset-0 z-40 cursor-default bg-scrim',
          leaving ? 'motion-fade-out pointer-events-none' : 'motion-fade'
        )}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Event"
        tabIndex={-1}
        inert={blocked || undefined}
        className={cn(
          'fixed inset-x-0 bottom-0 z-50 max-h-[85dvh] overflow-y-auto overscroll-contain rounded-t-card border-t border-line-strong bg-surface p-3 shadow-pop focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring',
          leaving ? 'motion-sheet-out pointer-events-none' : 'motion-sheet'
        )}
      >
        {children}
      </div>
    </>
  );
}
