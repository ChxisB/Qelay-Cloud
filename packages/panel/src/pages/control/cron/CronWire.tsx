import { ICON } from '@/components/layout/NavIcon';
import { ConnectionLine } from '@/components/ui/nodegraph/ConnectionLine';
import { ConnectionNode } from '@/components/ui/nodegraph/ConnectionNode';
import { cn } from '@/lib/cn';
import { useMinWidth } from '@/lib/useMinWidth';

/**
 * What the form describes, drawn as the schedule, a line and its queue, with the sentence that says it in words.
 * The line is drawn only once both ends are real: a schedule that does not parse, or no queue yet, leaves it out
 * (the next-runs note above says why in words).
 */
export function CronWire({
  when,
  valid,
  queue,
  job,
}: {
  /** The schedule as typed, or a plain-words interval. Empty until something is entered. */
  when: string;
  /** The schedule parses (a cron expression the preview accepts, or an interval above zero). */
  valid: boolean;
  queue: string;
  job: string;
}) {
  const wide = useMinWidth(640);
  return (
    <div
      role="group"
      aria-label="What this will do"
      className="flex flex-col gap-3 rounded-control border border-dashed border-line-strong p-3.5"
    >
      <div
        className={cn(
          'grid items-center gap-4',
          wide && 'grid-cols-[minmax(0,1fr)_64px_minmax(0,1fr)]'
        )}
      >
        <ConnectionNode
          kind="cron"
          icon={ICON.cron}
          name={when || 'not set yet'}
          sub="Schedule"
          placeholder={!when || !valid}
        />
        <div className={cn('h-8', !wide && 'mx-auto')}>
          {valid && queue && <ConnectionLine state="active" vertical={!wide} />}
        </div>
        <ConnectionNode
          kind="queue"
          icon={ICON.queues}
          name={queue || 'choose a queue'}
          sub="Queue"
          placeholder={!queue}
        />
      </div>
      <p className="m-0 text-[13px] text-muted">
        Adds a "{job || 'default'}" job to the queue each time the schedule fires.
      </p>
    </div>
  );
}
