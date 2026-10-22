import { type ReactNode, useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/cn';
import { usePresence } from '@/lib/usePresence';

/** The pause before the card closes once the pointer leaves, long enough to cross the gap to it. */
const LINGER_MS = 120;

/**
 * An extra beside a link: a card that opens on mouse hover or keyboard focus and closes 120ms after the pointer
 * leaves, on Escape, or when focus leaves both. It never moves focus, so Tab goes from the link into the card's own
 * controls and on. A touch tap does not open it (the link just goes where it goes), so nothing may live only here.
 * `trigger` draws the link and must put `aria-expanded` on it.
 */
export function HoverCard({
  trigger,
  label,
  children,
}: {
  trigger: (props: { 'aria-expanded': boolean }) => ReactNode;
  /** Names the card for assistive tech. */
  label: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const { mounted, leaving } = usePresence(open);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const show = () => {
    clearTimeout(timer.current);
    setOpen(true);
  };
  useEffect(() => () => clearTimeout(timer.current), []);

  return (
    <div
      // Not a widget: these handlers only listen to the link and the card inside it as they bubble.
      role="presentation"
      className="relative flex min-w-0"
      onPointerEnter={(e) => e.pointerType === 'mouse' && show()}
      onPointerLeave={(e) => {
        if (e.pointerType !== 'mouse') return;
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setOpen(false), LINGER_MS);
      }}
      onFocus={show}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) setOpen(false);
      }}
      onKeyDown={(e) => {
        if (e.key !== 'Escape' || !open) return;
        e.stopPropagation();
        clearTimeout(timer.current);
        setOpen(false);
      }}
    >
      {trigger({ 'aria-expanded': open })}
      {mounted && (
        <div
          role="group"
          aria-label={label}
          className={cn(
            'absolute top-[calc(100%+10px)] left-1/2 z-40 w-[408px] max-w-[calc(100vw-2rem)] -translate-x-1/2 cursor-default rounded-3xl border border-line-strong bg-raised p-[18px] text-left shadow-pop',
            // A bridge above the card keeps it open while the pointer crosses the gap.
            "before:absolute before:inset-x-0 before:-top-3 before:h-3 before:content-['']",
            leaving ? 'motion-leave pointer-events-none' : 'motion-drop'
          )}
        >
          {children}
        </div>
      )}
    </div>
  );
}
