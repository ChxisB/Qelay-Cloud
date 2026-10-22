import { useLayoutEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { cn } from '@/lib/cn';

export type LinkTab = { to: string; label: string; current: boolean };

/**
 * Tabs that are addresses: each is a link, so a tab can be bookmarked, shared and reached with the
 * back button. `aria-current` marks the open one; colour and weight are never the only signal. With motion
 * one underline slides to the open tab (as the sidebar highlight does); without it, or before the page has
 * a layout, each tab draws its own.
 */
export function LinkTabs({ label, tabs }: { label: string; tabs: readonly LinkTab[] }) {
  const navRef = useRef<HTMLElement>(null);
  const [mark, setMark] = useState<{ x: number; y: number; w: number } | null>(null);
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- no list on purpose: the bail-out below stops the loop
  useLayoutEffect(() => {
    const tab = navRef.current?.querySelector<HTMLElement>('[aria-current="page"]');
    const next =
      tab && tab.offsetWidth > 0
        ? { x: tab.offsetLeft, y: tab.offsetTop + tab.offsetHeight - 2, w: tab.offsetWidth }
        : null;
    setMark((prev) =>
      prev?.x === next?.x && prev?.y === next?.y && prev?.w === next?.w ? prev : next
    );
  });
  return (
    <nav
      ref={navRef}
      aria-label={label}
      data-tab-slide={mark ? '' : undefined}
      className="relative mb-4 flex flex-wrap gap-1 border-b border-line"
    >
      {mark && (
        <span
          aria-hidden="true"
          className="tab-ind pointer-events-none absolute top-0 left-0 h-0.5 w-px origin-top-left bg-hl"
          style={{ transform: `translate(${mark.x}px, ${mark.y}px) scaleX(${mark.w})` }}
        />
      )}
      {tabs.map((tab) => (
        <Link
          key={tab.to}
          to={tab.to}
          aria-current={tab.current ? 'page' : undefined}
          className={cn(
            '-mb-px inline-flex min-h-10 items-center border-b-2 px-3 text-sm transition-colors hover:text-fg',
            tab.current
              ? 'border-hl font-semibold text-fg'
              : 'border-transparent font-medium text-muted'
          )}
        >
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}
