import { IconButton } from '@/components/ui/Button';
import { Toggle } from '@/components/ui/form';
import { IconTrash } from '@/components/ui/icons';
import type { WebhookFull } from '@/lib/bqTypes';
import { formatNumber, formatRelativeTime } from '@/lib/format';
import { DeliveryHistory } from './DeliveryHistory';
import { displayWebhookUrl } from './model';

/** One registry row and, under it, the delivery history when it is open. */
export function WebhookRow({
  webhook: w,
  enabled,
  removing,
  open,
  onToggleOpen,
  onToggleEnabled,
  onRemove,
}: {
  webhook: WebhookFull;
  /** The switch as shown: the optimistic value while a change is in flight. */
  enabled: boolean;
  removing: boolean;
  open: boolean;
  onToggleOpen: () => void;
  onToggleEnabled: (next: boolean) => void;
  onRemove: () => void;
}) {
  return (
    <>
      <tr className="border-b border-line align-top last:border-0 hover:bg-surface-2/40">
        <td className="max-w-xs truncate px-4 py-2.5 font-mono text-xs text-fg">
          {displayWebhookUrl(w.url)}
          <span className="block font-sans text-[11px] text-faint">
            {w.signed ? 'signed' : 'unsigned'}
            {w.urlRedacted ? ' · path hidden' : ''}
          </span>
        </td>
        <td className="px-4 py-2.5 text-xs text-muted">{w.events.join(', ')}</td>
        <td className="px-4 py-2.5 font-mono text-xs text-muted">{w.queue ?? 'all'}</td>
        <td className="px-4 py-2.5 text-right tnum text-muted">
          <span className="text-success">{formatNumber(w.successCount)}</span>
          {' / '}
          <span className={w.failureCount ? 'text-danger' : ''}>
            {formatNumber(w.failureCount)}
          </span>
        </td>
        <td className="px-4 py-2.5 text-right text-faint">{formatRelativeTime(w.lastTriggered)}</td>
        <td className="px-4 py-2.5">
          <Toggle
            checked={enabled}
            label={`${enabled ? 'Disable' : 'Enable'} webhook`}
            onChange={onToggleEnabled}
          />
        </td>
        <td className="px-4 py-2.5 text-right">
          <button
            type="button"
            aria-expanded={open}
            aria-label={`${open ? 'Hide' : 'Show'} deliveries`}
            onClick={onToggleOpen}
            className="rounded-control px-2 py-1 text-xs font-medium text-link hover:bg-surface-2"
          >
            Deliveries
          </button>
        </td>
        <td className="px-4 py-2.5 text-right">
          <IconButton
            aria-label="Remove webhook"
            disabled={removing}
            onClick={() =>
              window.confirm(`Remove webhook for ${displayWebhookUrl(w.url)}?`) && onRemove()
            }
          >
            <IconTrash className="size-3.5" />
          </IconButton>
        </td>
      </tr>
      {open && (
        <tr className="border-b border-line bg-surface-2/30 last:border-0">
          <td colSpan={8} className="px-4 py-3">
            <DeliveryHistory id={w.id} enabled={w.enabled} />
          </td>
        </tr>
      )}
    </>
  );
}
