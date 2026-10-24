import { Button, IconButton } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import { Figure } from '@/components/ui/Figure';
import { Select } from '@/components/ui/form';
import { IconDownload } from '@/components/ui/icons';
import { SearchField } from '@/components/ui/SearchField';
import { StatCard } from '@/components/ui/StatCard';
import { StatusPill } from '@/components/ui/StatusBadge';
import { cn } from '@/lib/cn';
import { formatNumber } from '@/lib/format';

export interface DlqQueueOption {
  name: string;
  dlq: number;
}

export function DlqSummary({
  total,
  discoveryError,
  healthy,
  statsError,
  queue,
  topReason,
  pendingRetry,
  reasonCount,
}: {
  total: number | null;
  discoveryError: boolean;
  healthy: boolean;
  statsError: boolean;
  queue: string;
  topReason?: string;
  pendingRetry?: number;
  reasonCount?: number;
}) {
  const unreadable = discoveryError || total == null;
  return (
    <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-4">
      <StatCard
        label="Total in DLQ"
        value={total == null ? '—' : formatNumber(total)}
        tone={unreadable ? 'default' : healthy ? 'green' : 'red'}
        hint={
          discoveryError ? (
            <StatusPill state="delayed">Unavailable</StatusPill>
          ) : total == null ? (
            'Loading'
          ) : healthy ? (
            <StatusPill state="completed">Healthy</StatusPill>
          ) : (
            <StatusPill state="failed">Attention</StatusPill>
          )
        }
        compact
      />
      <StatCard
        label="Top reason"
        value={
          <span className="text-lg font-bold">
            {discoveryError || statsError
              ? 'Unavailable'
              : queue
                ? (topReason ?? 'No failures')
                : 'Select a queue'}
          </span>
        }
        compact
      />
      <StatCard
        label="Pending retry"
        value={pendingRetry == null ? '—' : formatNumber(pendingRetry)}
        hint={queue ? 'in this queue' : 'awaiting retry'}
        compact
      />
      <StatCard
        label="Failure types"
        value={reasonCount == null ? '—' : formatNumber(reasonCount)}
        hint="distinct reasons"
        compact
      />
    </div>
  );
}

export function DlqQueueGrid({
  queues,
  queue,
  onSelect,
}: {
  queues: DlqQueueOption[];
  queue: string;
  onSelect: (name: string) => void;
}) {
  if (queues.length === 0) return null;
  return (
    <Card className="mb-6">
      <CardHeader title="DLQ by queue" sub="Pick a queue to see only its jobs." />
      <div
        role="group"
        aria-label="DLQ by queue"
        className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-5"
      >
        {queues.map((item) => (
          <button
            key={item.name}
            type="button"
            aria-pressed={queue === item.name}
            onClick={() => onSelect(item.name)}
            className={cn(
              'rounded-[18px] border p-3 text-left transition-colors',
              queue === item.name ? 'border-hl bg-selected' : 'border-line hover:bg-hover'
            )}
          >
            <div className="truncate font-mono text-xs text-muted">{item.name}</div>
            <div className="mt-1 text-xl font-bold tnum text-danger">
              <Figure value={item.dlq} />
            </div>
          </button>
        ))}
      </div>
    </Card>
  );
}

export function DlqFilters({
  queue,
  queues,
  reason,
  reasons,
  sort,
  search,
  pageScoped,
  onQueue,
  onReason,
  onSort,
  onSearch,
  onExport,
  onRetryAll,
  retryingAll,
  nothingFailed,
}: {
  queue: string;
  queues: DlqQueueOption[];
  reason: string;
  reasons: string[];
  sort: 'newest' | 'oldest';
  search: string;
  pageScoped: boolean;
  onQueue: (value: string) => void;
  onReason: (value: string) => void;
  onSort: (value: 'newest' | 'oldest') => void;
  onSearch: (value: string) => void;
  onExport: () => void;
  /** Absent when the caller may not retry or the server has closed it. */
  onRetryAll?: () => void;
  retryingAll?: boolean;
  /** The queue's failed list is known to be empty. */
  nothingFailed?: boolean;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-center gap-3">
      <div className="w-48">
        <Select
          value={queue}
          aria-label="Queue"
          name="dlq-queue"
          autoComplete="off"
          onChange={(event) => onQueue(event.target.value)}
        >
          <option value="">Select a queue…</option>
          {queues.map((item) => (
            <option key={item.name} value={item.name}>
              {item.name}
              {item.dlq ? ` (${item.dlq})` : ''}
            </option>
          ))}
        </Select>
      </div>
      <div className="w-40">
        <Select
          value={reason}
          onChange={(event) => onReason(event.target.value)}
          aria-label="Filter by reason"
          name="dlq-reason-filter"
          autoComplete="off"
        >
          <option value="all">All reasons</option>
          {reasons.map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
        </Select>
      </div>
      <div className="w-44">
        <Select
          value={sort}
          onChange={(event) => onSort(event.target.value as 'newest' | 'oldest')}
          aria-label={pageScoped ? 'Sort this page' : 'Sort'}
          name="dlq-sort"
          autoComplete="off"
        >
          <option value="newest">Newest first{pageScoped ? ' (this page)' : ''}</option>
          <option value="oldest">Oldest First{pageScoped ? ' (this page)' : ''}</option>
        </Select>
      </div>
      <SearchField
        containerClassName="min-w-40 flex-1"
        value={search}
        onChange={(event) => onSearch(event.target.value)}
        placeholder="Filter this page by job ID…"
        aria-label="Filter this page by job ID"
        name="dlq-job-filter"
        autoComplete="off"
      />
      <IconButton
        size="sm"
        aria-label="Export this page to CSV"
        title="Export this page to CSV"
        disabled={!queue}
        onClick={onExport}
      >
        <IconDownload className="size-3.5" />
      </IconButton>
      {onRetryAll && (
        <Button disabled={!queue || retryingAll || nothingFailed} onClick={onRetryAll}>
          {retryingAll
            ? 'Retrying…'
            : reason === 'all'
              ? 'Retry up to 500'
              : 'Retry up to 500 with this reason'}
        </Button>
      )}
    </div>
  );
}
