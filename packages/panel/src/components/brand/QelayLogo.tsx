import { cn } from '@/lib/cn';
import { QelayMark } from './QelayMark';

/**
 * Horizontal lockup: the Q mark in a rounded app-icon tile, the "Qelay" wordmark and the
 * "Cloud console" subtitle. The tile carries the brand gradient with a dark glyph, as the design
 * draws it; the text takes theme tokens so it reads on both grounds.
 */
export function QelayLogo({ className }: { className?: string }) {
  return (
    <div className={cn('flex items-center gap-3', className)}>
      <span className="grid size-8 shrink-0 place-items-center rounded-[10px] bg-[linear-gradient(135deg,var(--brand-1),var(--brand-2))] text-on-ok">
        <QelayMark size={21} variant="mono" decorative />
      </span>
      <div className="flex flex-col">
        <span className="text-[15px] font-bold leading-[1.1] tracking-[-0.03em] text-fg">
          Qelay
        </span>
        <span className="text-xs font-semibold leading-[1.1] text-faint">Cloud console</span>
      </div>
    </div>
  );
}
