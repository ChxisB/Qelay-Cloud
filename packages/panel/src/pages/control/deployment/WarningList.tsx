import { cn } from '@/lib/cn';
import type { DeploymentWarning } from '@/lib/ops/types';

const LABEL = { critical: 'Critical', warning: 'Warning' } as const;

/**
 * What is wrong with this deployment, worst first. The server words each warning, so the panel and
 * an alert rule say the same thing; severity is spelled out so it does not rest on colour.
 */
export function WarningList({ warnings }: { warnings: readonly DeploymentWarning[] }) {
  if (warnings.length === 0) {
    return (
      <section
        aria-label="Warnings"
        className="rounded-card border border-line bg-surface px-5 py-4 text-sm text-muted"
      >
        <span className="font-semibold text-fg">No warnings.</span> The database, the transport and
        the tick are all reporting normally.
      </section>
    );
  }
  const ordered = [...warnings].sort(
    (a, b) => Number(b.severity === 'critical') - Number(a.severity === 'critical')
  );
  return (
    <section aria-label="Warnings" className="flex flex-col gap-3">
      {ordered.map((warning) => (
        <div
          key={warning.code}
          role={warning.severity === 'critical' ? 'alert' : 'status'}
          data-warning={warning.code}
          className={cn(
            'flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-card border bg-surface px-5 py-3.5',
            warning.severity === 'critical' ? 'border-danger/40' : 'border-warning/40'
          )}
        >
          <span
            className={cn(
              'eyebrow',
              warning.severity === 'critical' ? 'text-danger' : 'text-warning'
            )}
          >
            {LABEL[warning.severity]}
          </span>
          <span className="min-w-0 flex-[1_1_320px] text-sm text-fg">{warning.message}</span>
          <code className="text-xs text-faint">{warning.code}</code>
        </div>
      ))}
    </section>
  );
}
