import { useChangeFlash } from '@/lib/useChangeFlash';

/**
 * A reading in text that washes once when a poll really changes it, and on nothing else. `steady` is for a reading
 * that moves on every poll ("12s ago", an uptime): it updates without the wash.
 */
export function Wash({ value, steady }: { value: string; steady?: boolean }) {
  const flash = useChangeFlash(value);
  return (
    <span key={flash} className={!steady && flash > 0 ? 'motion-flash' : undefined}>
      {value}
    </span>
  );
}
