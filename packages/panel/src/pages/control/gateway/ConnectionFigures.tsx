import type { WebhookGroupStatFull } from '@/lib/bq';
import type { WebhookFull } from '@/lib/bqTypes';
import { formatNumber } from '@/lib/format';
import { useChangeFlash } from '@/lib/useChangeFlash';
import { TrendBars } from './ConnectionTrend';

/** One figure and its word. It washes once when a poll moves the number, and on nothing else. */
export function Figure({
  value,
  word,
  bad = false,
}: {
  value: number;
  word: string;
  bad?: boolean;
}) {
  const flash = useChangeFlash(value);
  return (
    <span>
      <b
        key={flash}
        className={`font-extrabold tnum ${flash > 0 ? 'motion-flash' : ''} ${bad && value > 0 ? 'text-danger' : 'text-fg'}`}
      >
        {formatNumber(value)}
      </b>{' '}
      {word}
    </span>
  );
}

/**
 * What a connection did in the last 24 hours: the bars, then successful, failed and waiting-now counts.
 * `stat` is absent when the server cannot give the grouped read; the lifetime totals are shown then, and say so.
 */
export function ConnectionFigures({
  route,
  stat,
  grouped,
}: {
  route: WebhookFull;
  stat: WebhookGroupStatFull | undefined;
  grouped: boolean;
}) {
  const ok = grouped ? (stat?.delivered ?? 0) : route.successCount;
  const failed = grouped ? (stat?.failed ?? 0) : route.failureCount;
  const waiting = grouped ? (stat?.pending ?? 0) : 0;
  if (ok + failed + waiting === 0) {
    return <span className="text-[13px] font-bold text-faint">No events</span>;
  }
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      {stat && <TrendBars stat={stat} className="h-[30px] w-[72px] flex-none" />}
      <span className="flex min-w-0 flex-col text-[13px] leading-snug text-muted">
        <Figure value={ok} word="successful" />
        <Figure value={failed} word="failed" bad />
        {waiting > 0 && <Figure value={waiting} word="waiting now" />}
        {grouped ? (
          <span className="sr-only">in the last 24 hours</span>
        ) : (
          <span className="text-xs text-faint">in total</span>
        )}
      </span>
    </div>
  );
}
