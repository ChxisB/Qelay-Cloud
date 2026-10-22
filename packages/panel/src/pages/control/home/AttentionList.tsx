import { IconDlq } from '@/components/ui/icons';
import { LinkButton } from '@/components/ui/LinkButton';
import { StatusGlyph } from '@/components/ui/StatusBadge';
import { cn } from '@/lib/cn';
import { stagger } from '@/lib/stagger';
import { useLeavers } from '@/lib/useLeavers';
import type { HomeIssue } from './model';

/**
 * Every open problem in one place, worst first. It says "Nothing needs attention" only once every
 * source has answered, and names the ones that did not, so a missing reading is never a clean bill.
 * It is a polite live region: a problem that appears is announced once, rises in, and fades out when it clears.
 */
export function AttentionList({
  issues,
  settled,
  unavailable,
}: {
  issues: readonly HomeIssue[];
  /** Every source has answered or failed; until then an empty list means "not known yet". */
  settled: boolean;
  unavailable: readonly string[];
}) {
  const rows = useLeavers(issues);
  if (issues.length === 0 && !settled) return null;
  return (
    <section
      aria-label="Needs attention"
      aria-live="polite"
      className={`flex flex-col gap-3 rounded-card border bg-surface px-4 py-[18px] ${issues.length > 0 ? 'border-danger/40' : 'border-line'}`}
    >
      <div className="eyebrow text-muted">Needs attention</div>
      {rows.length === 0 ? (
        <p className="m-0 flex items-center gap-2 text-sm text-fg">
          <StatusGlyph state={unavailable.length > 0 ? 'waiting' : 'completed'} small />
          <span>
            Nothing needs attention
            {unavailable.length > 0 ? ' in what could be read.' : '.'}
          </span>
        </p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {rows.map(({ item: issue, leaving }, index) => (
            <li
              key={issue.id}
              style={stagger(index)}
              inert={leaving}
              className={cn(
                'flex flex-wrap items-center gap-x-5 gap-y-3',
                leaving ? 'motion-leave' : 'motion-arrive'
              )}
            >
              <div className="flex size-8 shrink-0 items-center justify-center rounded-control bg-state-failed-bg text-danger">
                <IconDlq className="size-5" />
              </div>
              <div className="flex min-w-0 flex-[1_1_280px] flex-col gap-1">
                <div className="text-base font-semibold tracking-[-0.01em] text-fg">
                  {issue.headline}
                </div>
                <div className="text-[13px] text-muted">{issue.detail}</div>
              </div>
              <LinkButton to={issue.to} variant="primary">
                {issue.label}
              </LinkButton>
            </li>
          ))}
        </ul>
      )}
      {unavailable.length > 0 && (
        <p className="m-0 text-[13px] text-muted">Could not be read: {unavailable.join(', ')}.</p>
      )}
    </section>
  );
}
