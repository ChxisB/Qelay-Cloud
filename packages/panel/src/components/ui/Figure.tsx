import { formatNumber } from '@/lib/format';
import { useChangeFlash } from '@/lib/useChangeFlash';

/** A count in a table cell that washes once when a poll really changes it, and on nothing else. */
export function Figure({ value }: { value: number }) {
  const flash = useChangeFlash(value);
  return (
    <span key={flash} className={flash > 0 ? 'motion-flash' : undefined}>
      {formatNumber(value)}
    </span>
  );
}
