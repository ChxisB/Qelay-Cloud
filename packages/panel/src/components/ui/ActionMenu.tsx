import { type KeyboardEvent, useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { cn } from '@/lib/cn';
import { usePresence } from '@/lib/usePresence';
import { IconButton } from './Button';
import { IconMore } from './icons';

export interface ActionItem {
  label: string;
  /** A link item goes there; an action item calls `onSelect`. */
  to?: string;
  onSelect?: () => void;
  /** Stays in the menu and in the arrow-key order, but does nothing. `hint` says why. */
  disabled?: boolean;
  hint?: string;
  /** A removal: red, and set apart from the rest by a rule. */
  danger?: boolean;
}

const ITEM =
  'flex min-h-9 w-full items-center rounded-[10px] px-3 text-left text-[13.5px] font-semibold ' +
  'transition-colors duration-(--duration-hover) ease-settle focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring';

/**
 * The few actions that do not earn a button of their own, behind one "more" button. It follows the menu
 * button pattern: the button names itself and the list (`label`), opening puts focus on the first item,
 * arrows, Home and End move, Escape closes and gives focus back, and Tab, a pick or a click outside close it.
 * It holds only what the page already offers elsewhere: nothing lives here alone.
 */
export function ActionMenu({ label, items }: { label: string; items: readonly ActionItem[] }) {
  const [open, setOpen] = useState(false);
  const { mounted, leaving } = usePresence(open);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const id = useId();

  const entries = () =>
    Array.from(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);

  useEffect(() => {
    if (open) entries()[0]?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const away = (e: Event) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [open]);

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) trigger.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (!open) return;
    if (e.key === 'Escape') {
      e.stopPropagation();
      close(true);
      return;
    }
    if (e.key === 'Tab') return setOpen(false);
    const list = entries();
    const at = list.indexOf(document.activeElement as HTMLElement);
    const to = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: list.length - 1 }[e.key];
    if (to === undefined || at < 0) return;
    e.preventDefault();
    list[(to + list.length) % list.length]?.focus();
  };

  return (
    <div ref={root} className="relative" role="presentation" onKeyDown={onKeyDown}>
      <IconButton
        ref={trigger}
        size="sm"
        variant="ghost"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={mounted ? id : undefined}
        onClick={() => setOpen((was) => !was)}
      >
        <IconMore className="size-4" />
      </IconButton>
      {mounted && (
        <div
          ref={menu}
          id={id}
          role="menu"
          aria-label={label}
          className={cn(
            'absolute top-[calc(100%+6px)] right-0 z-40 flex min-w-52 flex-col rounded-[14px] border border-line-strong bg-raised p-1.5 shadow-pop',
            leaving ? 'motion-leave pointer-events-none' : 'motion-drop'
          )}
        >
          {items.map((item, i) => {
            const props = {
              role: 'menuitem',
              tabIndex: -1,
              title: item.disabled ? item.hint : undefined,
              'aria-disabled': item.disabled || undefined,
              className: cn(
                ITEM,
                item.danger
                  ? 'text-danger hover:bg-danger-tint focus-visible:bg-danger-tint'
                  : 'text-fg hover:bg-hover focus-visible:bg-hover',
                item.disabled && 'cursor-not-allowed opacity-50 hover:bg-transparent'
              ),
            };
            const pick = () => {
              if (item.disabled) return;
              close(true);
              item.onSelect?.();
            };
            return (
              <div
                key={item.label}
                role="none"
                className={cn(item.danger && i > 0 && 'mt-1.5 border-t border-line pt-1.5')}
              >
                {item.to && !item.disabled ? (
                  <Link {...props} to={item.to} onClick={() => setOpen(false)}>
                    {item.label}
                  </Link>
                ) : (
                  <button type="button" {...props} onClick={pick}>
                    {item.label}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
