import { useEffect, useRef, useState } from 'react';
import {
  mayRestoreModalFocus,
  useGlobalModalStore,
} from '@/components/dashboard/stores/globalModalStore';
import { iconButtonClass } from '@/components/ui/Button';
import { CodeBlock } from '@/components/ui/CodeBlock';
import { CopyButton } from '@/components/ui/CopyButton';
import { IconClose } from '@/components/ui/icons';
import { bq } from '@/lib/bq';
import { cn } from '@/lib/cn';
import { pretty } from './dbUtils';

/* ------------------------------- row detail -------------------------------- */

const DIALOG_FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export function RowDetailDrawer({
  table,
  columns,
  row,
  rowid,
  truncated,
  leaving = false,
  onClose,
}: {
  table: string;
  columns: string[];
  row: unknown[];
  rowid: number | string | null;
  truncated: boolean[];
  /** Closed and sliding away: it no longer traps focus or answers a click. */
  leaving?: boolean;
  onClose: () => void;
}) {
  // Full values for cells the grid truncated, lazy-fetched by rowid.
  const [full, setFull] = useState<Record<string, unknown>>({});
  const [loadErrors, setLoadErrors] = useState<Record<string, string>>({});
  const panelRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  // A confirm over the drawer keeps it on screen but out of reach.
  const blocked = useGlobalModalStore((s) => s.active === 'confirm');

  useEffect(() => {
    if (leaving) return;
    const invoker = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    const focusables = () =>
      panel
        ? Array.from(panel.querySelectorAll<HTMLElement>(DIALOG_FOCUSABLE)).filter(
            (element) => element.getAttribute('aria-hidden') !== 'true'
          )
        : [];
    const focusInside = (last = false) => {
      const candidates = focusables();
      (last ? candidates.at(-1) : candidates[0])?.focus();
      if (candidates.length === 0) panel?.focus();
    };
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
      const first = candidates[0];
      const last = candidates[candidates.length - 1];
      if (event.shiftKey && (active === first || !active || !panel?.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !active || !panel?.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    };
    const onFocus = (event: FocusEvent) => {
      if (useGlobalModalStore.getState().active === 'confirm') return;
      if (panel && !panel.contains(event.target as Node)) focusInside();
    };

    closeRef.current?.focus();
    if (document.activeElement !== closeRef.current) panel?.focus();
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('focusin', onFocus);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('focusin', onFocus);
      if (mayRestoreModalFocus('database-row') && invoker?.isConnected) invoker.focus();
    };
  }, [leaving]);

  // Stable key of the truncated columns in this immutable row selection.
  const truncatedKey = JSON.stringify(columns.filter((_, i) => truncated[i]));
  useEffect(() => {
    // Drop the previous selection's fetched cells before issuing its own reads.
    setFull({});
    setLoadErrors({});
    const cols = JSON.parse(truncatedKey) as string[];
    if (rowid == null || cols.length === 0) return;
    let cancelled = false;
    void Promise.all(
      cols.map(async (col) => {
        try {
          const r = await bq.db.cell(table, rowid, col);
          if (!r || typeof r !== 'object' || !Object.hasOwn(r, 'value')) {
            throw new Error('Malformed full-cell response.');
          }
          if (!cancelled) setFull((current) => ({ ...current, [col]: r.value }));
        } catch (error) {
          if (!cancelled) {
            const message = error instanceof Error ? error.message : String(error);
            setLoadErrors((current) => ({ ...current, [col]: message.slice(0, 300) }));
          }
        }
      })
    );
    return () => {
      cancelled = true;
    };
  }, [table, rowid, truncatedKey]);

  return (
    <>
      <button
        type="button"
        aria-label="Close row detail"
        onClick={onClose}
        inert={blocked || undefined}
        className={cn(
          'fixed inset-0 z-40 cursor-default bg-scrim',
          leaving ? 'motion-fade-out pointer-events-none' : 'motion-fade'
        )}
      />
      <aside
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={`${table} row ${rowid ?? 'detail'}`}
        tabIndex={-1}
        inert={blocked || undefined}
        className={cn(
          'fixed inset-y-0 right-0 z-50 flex w-full max-w-[580px] flex-col border-l border-line-strong bg-surface shadow-pop focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring',
          leaving ? 'motion-slide-out pointer-events-none' : 'motion-slide'
        )}
      >
        <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
          <h2 className="m-0 min-w-0 break-words font-mono text-lg font-bold text-fg">
            {table} · row detail
          </h2>
          <button
            ref={closeRef}
            type="button"
            aria-label="Close"
            onClick={onClose}
            className={iconButtonClass('ghost', 'sm')}
          >
            <IconClose className="size-4" />
          </button>
        </div>
        <div className="flex-1 overscroll-contain overflow-y-auto p-4">
          <dl className="flex flex-col gap-4">
            {columns.map((c, i) => {
              const loaded = Object.hasOwn(full, c);
              const value = loaded ? full[c] : row[i];
              const text = pretty(value);
              const multiline = text.includes('\n') || text.length > 80;
              return (
                <div key={c}>
                  <dt className="mb-1 flex flex-wrap items-center gap-1.5 font-mono text-[13px] font-bold text-muted">
                    {c}
                    {value != null && <CopyButton value={String(value)} />}
                    {truncated[i] &&
                      !loaded &&
                      // WITHOUT ROWID tables have no key to lazy-fetch the full
                      // value by, so no request is ever issued for it.
                      (rowid == null ? (
                        <span className="font-sans font-bold text-warning">
                          (truncated — full value unavailable: this table has no rowid to fetch it
                          by)
                        </span>
                      ) : Object.hasOwn(loadErrors, c) ? (
                        <span role="alert" className="font-sans font-bold text-danger">
                          (full value unavailable — {loadErrors[c]})
                        </span>
                      ) : (
                        <span className="font-sans font-bold text-warning">
                          (loading full value…)
                        </span>
                      ))}
                  </dt>
                  {/* A value that has just loaded fades in over the truncated one. */}
                  <dd className={loaded ? 'motion-fade' : undefined}>
                    {value == null ? (
                      <span className="italic text-muted">NULL</span>
                    ) : multiline ? (
                      <CodeBlock label={`${c} value`} className="whitespace-pre-wrap break-words">
                        {text}
                      </CodeBlock>
                    ) : (
                      <span className="break-words font-mono text-[13px] text-fg">{text}</span>
                    )}
                  </dd>
                </div>
              );
            })}
          </dl>
        </div>
      </aside>
    </>
  );
}
