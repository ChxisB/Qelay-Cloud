import type { WebhookDeliveryFull } from '@/lib/bq';
import { cn } from '@/lib/cn';
import { formatDateTime, formatMs } from '@/lib/format';
import { stagger } from '@/lib/stagger';
import { EVENT_WORDS } from './model';

type Attempt = WebhookDeliveryFull['history'][number];

/** An attempt that got no answer, an error, or a 4xx or 5xx did not deliver. */
export const attemptFailed = (entry: Attempt): boolean =>
  entry.error !== null || entry.statusCode === null || entry.statusCode >= 400;

// A square stop is a failure and a round one is not, so the shape says it without the colour.
function Stop({ shape }: { shape: 'failed' | 'sent' | 'open' }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'absolute top-[3px] -left-6 size-3.5 ring-4 ring-surface',
        shape === 'failed' && 'rounded-[3px] bg-danger-fill',
        shape === 'sent' && 'rounded-full bg-success',
        shape === 'open' && 'rounded-full border-2 border-line-strong bg-surface'
      )}
    />
  );
}

/**
 * Every attempt kept for an event, oldest first, as stops on a line that ends in how the event stands now. Each stop
 * says it in words as well: its number, Failed or Sent, when, how long, what the receiver answered and why it failed.
 * The stops arrive one after the other. The store keeps no request or response body, so none is shown.
 */
export function AttemptLine({ delivery, held }: { delivery: WebhookDeliveryFull; held: boolean }) {
  const end =
    delivery.status === 'failed' ? 'failed' : delivery.status === 'delivered' ? 'sent' : 'open';
  return (
    <ol
      aria-label="Attempts, oldest first"
      className="relative m-0 flex list-none flex-col gap-3 p-0 pl-6"
    >
      <span
        aria-hidden="true"
        className="absolute top-2 bottom-2 left-[7px] w-0.5 rounded-sm bg-line-strong"
      />
      {delivery.history.map((entry, i) => {
        const bad = attemptFailed(entry);
        return (
          <li
            key={entry.attempt}
            style={stagger(i)}
            className="motion-arrive relative min-w-0 text-[13px]"
          >
            <Stop shape={bad ? 'failed' : 'sent'} />
            <b className="text-fg">Attempt {entry.attempt}</b>{' '}
            <span className={bad ? 'text-danger' : 'text-muted'}>{bad ? 'Failed' : 'Sent'}</span>
            <span className="block text-muted">
              {formatDateTime(entry.at)} · took {formatMs(entry.durationMs)} · HTTP{' '}
              <span className="font-mono">{entry.statusCode ?? 'no answer'}</span>
            </span>
            {entry.error && <span className="block break-words text-danger">{entry.error}</span>}
          </li>
        );
      })}
      <li
        style={stagger(delivery.history.length)}
        className="motion-arrive relative min-w-0 text-[13px]"
      >
        <Stop shape={end} />
        <b className="text-fg">{held ? 'On hold' : EVENT_WORDS[delivery.status]}</b>
        {delivery.finishedAt !== null && (
          <span className="block text-muted">{formatDateTime(delivery.finishedAt)}</span>
        )}
      </li>
    </ol>
  );
}
