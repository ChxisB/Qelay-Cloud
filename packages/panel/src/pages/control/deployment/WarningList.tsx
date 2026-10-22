import { useMemo, useState } from 'react';
import { Banner } from '@/components/ui/Banner';
import { StatusPill } from '@/components/ui/StatusBadge';
import { cn } from '@/lib/cn';
import type { DeploymentWarning } from '@/lib/ops/types';
import { stagger } from '@/lib/stagger';
import { useFirstLoad } from '@/lib/useFirstLoad';
import { useLeavers } from '@/lib/useLeavers';

const LABEL = { critical: 'Critical', warning: 'Warning' } as const;

/** One warning. Where it rises in the stagger is read once, when it appears: a later poll must not restart it. */
function WarningRow({
  warning,
  arrive,
  leaving,
}: {
  warning: DeploymentWarning;
  arrive: number;
  leaving: boolean;
}) {
  const [place] = useState(arrive);
  const critical = warning.severity === 'critical';
  return (
    <div
      role={critical ? 'alert' : 'status'}
      data-warning={warning.code}
      inert={leaving}
      style={stagger(place)}
      className={cn(
        'flex flex-wrap items-center gap-x-4 gap-y-2 rounded-card border border-line px-4 py-[18px]',
        critical ? 'bg-danger-tint' : 'bg-state-waiting-bg',
        leaving ? 'motion-leave' : 'motion-arrive'
      )}
    >
      <StatusPill state={critical ? 'failed' : 'delayed'}>{LABEL[warning.severity]}</StatusPill>
      <span className="min-w-0 flex-[1_1_320px] text-[13px] text-fg">{warning.message}</span>
      <code className="text-[13px] text-muted">{warning.code}</code>
    </div>
  );
}

/**
 * What is wrong with this deployment, worst first. The server words each warning, so the panel and
 * an alert rule say the same thing; severity is a pill with a glyph and a word, so it does not
 * rest on colour. A critical warning is announced assertively, an ordinary one politely. The warnings that come
 * with the first load rise in order; one that appears later rises alone, and one that clears leaves.
 */
export function WarningList({ warnings }: { warnings: readonly DeploymentWarning[] }) {
  const first = useFirstLoad(true);
  const ordered = useMemo(
    () =>
      [...warnings]
        .sort((a, b) => Number(b.severity === 'critical') - Number(a.severity === 'critical'))
        .map((warning) => ({ ...warning, id: warning.code })),
    [warnings]
  );
  const rows = useLeavers(ordered);
  if (rows.length === 0) {
    return (
      <section aria-label="Warnings">
        <Banner tone="ok" title="No warnings.">
          The database, the queue service and maintenance are all reporting normally.
        </Banner>
      </section>
    );
  }
  return (
    <section aria-label="Warnings" className="flex flex-col gap-3">
      {rows.map(({ item, leaving }, index) => (
        <WarningRow key={item.code} warning={item} arrive={first ? index : 0} leaving={leaving} />
      ))}
    </section>
  );
}
