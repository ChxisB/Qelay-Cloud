import { cn } from '@/lib/cn';
import { QelayMark } from './QelayMark';

/**
 * Horizontal lockup: mark, "Qelay" wordmark and the "Control panel" subtitle.
 * Text colours come from theme tokens so the lockup reads on both grounds; the
 * mark keeps its own gradient. The subtitle uses `muted` (not `faint`) because
 * the light sidebar is `#F1F5F9`, where `faint` falls under 4.5:1.
 */
export function QelayLogo({ className }: { className?: string }) {
  return (
    <div className={cn('flex items-center gap-2.5', className)}>
      <QelayMark size={34} decorative />
      <div className="flex flex-col gap-1">
        <span className="text-[20px] font-extrabold leading-none tracking-[-0.045em] text-fg">
          Qelay
        </span>
        <span className="text-[10px] font-semibold uppercase leading-none tracking-[0.18em] text-muted">
          Control panel
        </span>
      </div>
    </div>
  );
}
