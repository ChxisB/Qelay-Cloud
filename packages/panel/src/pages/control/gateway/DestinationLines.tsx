import { ConnectionLine } from '@/components/ui/nodegraph/ConnectionLine';
import { cn } from '@/lib/cn';

/** More lines than this would crowd a card; the rest are counted. */
const SHOWN = 4;

/**
 * One short line per connection that runs into the address. The panel knows how many, not which, so the lines carry
 * no names and are decoration: the card's sentence says the count in words. They turn dashed while the address is
 * being changed ("about to move"), and `flash` is a count that moves when the saved address really changed.
 */
export function DestinationLines({
  count,
  moving,
  flash,
}: {
  count: number;
  moving: boolean;
  flash: number;
}) {
  if (count === 0) return null;
  const shown = Math.min(count, SHOWN);
  return (
    <div
      key={flash}
      aria-hidden="true"
      data-lines={shown}
      data-moving={moving || undefined}
      className={cn('flex w-28 shrink-0 flex-col gap-2 px-4 py-1', flash > 0 && 'motion-flash')}
    >
      {Array.from({ length: shown }, (_, i) => (
        <div key={i} className="h-3">
          <ConnectionLine state={moving ? 'held' : 'active'} index={i} />
        </div>
      ))}
      {count > shown && <span className="text-xs text-muted">+{count - shown} more</span>}
    </div>
  );
}
