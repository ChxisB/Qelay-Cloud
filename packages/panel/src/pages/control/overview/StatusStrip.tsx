import { Link } from 'react-router-dom';
import { type StateRole, StatusGlyph } from '@/components/ui/StatusBadge';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { ago, figure, stripTone, TONE_WORD, type Tone } from '@/lib/ops/health';
import type { DeploymentView } from '@/lib/ops/types';
import { usePolledData } from '@/lib/usePolledData';

const GLYPH: Record<Tone, StateRole> = {
  green: 'completed',
  amber: 'delayed',
  red: 'failed',
  zinc: 'waiting',
};

const BORDER: Record<Tone, string> = {
  green: 'border-line',
  amber: 'border-warning/50',
  red: 'border-danger/50',
  zinc: 'border-line',
};

function tickText(tick: DeploymentView['tick']): string {
  switch (tick.state) {
    case 'never':
      return 'Maintenance has not run yet';
    case 'unknown':
      return 'Maintenance status unknown';
    default:
      return `Maintenance ran ${ago(tick.ageMs)}`;
  }
}

function doorbellText(doorbells: DeploymentView['doorbells']): string {
  if (doorbells.notRung === null) return 'Worker notifications unknown';
  const more = doorbells.partial ? '+' : '';
  return `${figure(doorbells.notRung)}${more} job${doorbells.notRung === 1 && !doorbells.partial ? '' : 's'} not yet notified to workers`;
}

/**
 * One line on the Dashboard: is the repair loop running and are the doorbells keeping up. It links
 * to the Deployment page, which says why. A figure that could not be read says "unknown"; the strip
 * never turns a missing reading into a healthy zero.
 */
export function StatusStrip() {
  const { data, error } = usePolledData(() => api.deployment(), []);
  return <StatusStripView data={data} error={error} />;
}

/** The strip for a deployment answer someone else polled, so a page that needs it too asks once. */
export function StatusStripView({
  data,
  error,
}: {
  data: DeploymentView | null;
  error: Error | null;
}) {
  const tone: Tone = data ? stripTone(data) : 'zinc';
  const word = data ? TONE_WORD[tone] : error ? 'Unknown' : 'Checking';
  const lines = data
    ? [tickText(data.tick), doorbellText(data.doorbells)]
    : [error ? 'Deployment status is unavailable' : 'Reading deployment status…'];
  return (
    <Link
      to="/deployment"
      data-testid="status-strip"
      data-tone={tone}
      aria-label={`Job delivery: ${word}. ${lines.join('. ')}. Open the deployment page.`}
      className={cn(
        'flex flex-wrap items-center gap-x-5 gap-y-1.5 rounded-card border bg-surface px-4 py-3 text-sm hover:bg-hover',
        BORDER[tone]
      )}
    >
      <span className="flex items-center gap-2.5 font-semibold text-fg">
        <StatusGlyph state={GLYPH[tone]} />
        {word}
      </span>
      {lines.map((line) => (
        <span key={line} className="text-muted">
          {line}
        </span>
      ))}
      <span className="ml-auto text-xs text-primary">Deployment →</span>
    </Link>
  );
}
