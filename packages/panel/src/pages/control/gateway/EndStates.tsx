import { Card, CardHeader } from '@/components/ui/Card';
import { Meter } from '@/components/ui/charts/HBars';
import type { Tone } from '@/components/ui/charts/tones';
import type { WebhookStatsFull } from '@/lib/bq';
import { formatNumber, formatPercent } from '@/lib/format';
import { useChangeFlash } from '@/lib/useChangeFlash';

/** A figure that washes once when a poll really changes it, and on nothing else. */
function Figure({ value, className }: { value: number; className?: string }) {
  const flash = useChangeFlash(value);
  return (
    <b key={flash} className={`tnum ${className ?? ''} ${flash > 0 ? 'motion-flash' : ''}`}>
      {formatNumber(value)}
    </b>
  );
}

function Share({
  label,
  count,
  total,
  tone,
}: {
  label: string;
  count: number;
  total: number;
  tone: Tone;
}) {
  return (
    <li className="grid grid-cols-[5.5rem_1fr] items-center gap-x-3 gap-y-1 sm:grid-cols-[5.5rem_1fr_9rem]">
      <span className="text-[13px] font-bold text-fg">{label}</span>
      <Meter value={count} max={total} tone={tone} />
      <span className="col-span-2 text-[13px] text-muted sm:col-span-1 sm:text-right">
        <Figure value={count} className="text-fg" /> ·{' '}
        {formatPercent(total > 0 ? count / total : 0, 1)}
      </span>
    </li>
  );
}

/**
 * Where the events of the range ended up: the total that matched, then how much of it was delivered, failed or is
 * still waiting. Each row is its count and share in words, with the bar as a second reading. All three counts come
 * with the stats the six numbers above already read.
 */
export function EndStates({ stats }: { stats: WebhookStatsFull }) {
  const total = stats.delivered + stats.failed + stats.pending;
  return (
    <Card>
      <CardHeader title="Where events went" headingLevel={3} />
      <div className="grid gap-4 md:grid-cols-[10rem_1fr] md:items-center">
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted">Events matched</span>
          <Figure value={total} className="text-2xl text-fg" />
        </div>
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          <Share label="Successful" count={stats.delivered} total={total} tone="ok" />
          <Share label="Failed" count={stats.failed} total={total} tone="bad" />
          <Share label="Pending" count={stats.pending} total={total} tone="warn" />
        </ul>
      </div>
    </Card>
  );
}
