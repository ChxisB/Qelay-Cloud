import { Card, CardHeader } from '@/components/ui/Card';
import { StatusGlyph, stateRole } from '@/components/ui/StatusBadge';
import type { JobFull } from '@/lib/bqTypes';
import { formatDateTime } from '@/lib/format';
import { stagger } from '@/lib/stagger';

/**
 * Attempt/state history: enqueued → started → finished (+ retries), each entry
 * from `job.timeline` (server-persisted, capped at MAX_TIMELINE_ENTRIES=20).
 * A line is drawn down through the entries' glyphs, and each entry arrives after the one above it.
 */
export function JobTimeline({ timeline }: { timeline: JobFull['timeline'] }) {
  const entries = timeline ?? [];
  return (
    <Card>
      <CardHeader title="Timeline" />
      {entries.length === 0 ? (
        <p className="text-[13px] text-muted">No state transitions recorded yet.</p>
      ) : (
        <div className="relative">
          <span
            aria-hidden="true"
            className="motion-draw-y absolute top-2.5 bottom-2.5 left-2 w-0.5 rounded-sm bg-line-strong"
          />
          <ol aria-label="What happened to this job, in order" className="flex flex-col gap-4">
            {entries.map((e, i) => (
              <li
                // Timeline entries have no stable id; index is fine, order is append-only.
                // oxlint-disable-next-line react/no-array-index-key -- append-only server log, stable order
                key={i}
                style={stagger(i)}
                className="motion-arrive relative flex gap-3"
              >
                <span className="relative grid size-[18px] shrink-0 place-items-center rounded-full bg-surface">
                  <StatusGlyph state={stateRole(e.state)} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                    <b className="text-[13px] leading-tight capitalize">
                      {e.state || 'unknown'}
                      {e.attempt != null && (
                        <span className="ml-2 font-mono font-normal text-muted">
                          attempt {e.attempt}
                        </span>
                      )}
                    </b>
                    <span className="font-mono text-xs text-muted">
                      {formatDateTime(e.timestamp)}
                    </span>
                  </div>
                  {e.worker && <div className="font-mono text-[13px] text-muted">{e.worker}</div>}
                  {e.error && (
                    <div className="mt-0.5 text-[13px] font-semibold text-danger">{e.error}</div>
                  )}
                </div>
              </li>
            ))}
          </ol>
        </div>
      )}
    </Card>
  );
}
