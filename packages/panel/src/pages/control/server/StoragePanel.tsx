import { Card } from '@/components/ui/Card';
import { CopyButton } from '@/components/ui/CopyButton';
import type { DbStats } from '@/lib/bqTypes';
import { cn } from '@/lib/cn';
import { formatBytes, formatRelativeTime } from '@/lib/format';
import type { DiskHealth } from './diskHealth';

const SEGMENTS = [
  { key: 'size', label: 'Database', abbr: null, color: 'bg-[var(--brand-3)]' },
  { key: 'walSize', label: 'Write-ahead log', abbr: 'WAL', color: 'bg-[var(--brand-1)]' },
  { key: 'shmSize', label: 'Shared memory', abbr: 'SHM', color: 'bg-faint' },
] as const;

/** "40.7 MB" as a number and a unit, so the unit can sit small beside the figure. */
function splitBytes(bytes: number): { value: string; unit: string } {
  const [value = '0', unit = 'B'] = formatBytes(bytes).split(' ');
  return { value, unit };
}

/**
 * On-disk footprint of the SQLite store: the total, one proportional bar (db + WAL + SHM) and
 * a row per part — the shape of the data is the information. The disk line comes from the
 * server's `/storage` and is absent when that is unknown, never assumed healthy.
 */
export function StoragePanel({ db, disk = null }: { db: DbStats; disk?: DiskHealth | null }) {
  const total = db.totalSize || 0;
  const hasData = db.exists && total > 0;
  const { value, unit } = splitBytes(total);

  return (
    <Card className="flex flex-col gap-5 p-6">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 className="text-[15px] font-semibold tracking-tight text-fg">Storage</h2>
          <p
            className="flex min-w-0 items-center gap-1.5 font-mono text-xs text-muted"
            title={db.path}
          >
            <span className="truncate">{db.path}</span>
            <CopyButton value={db.path} />
          </p>
        </div>
        {db.exists ? (
          <div className="shrink-0 text-[28px] font-bold leading-[1.1] tracking-tight tnum text-fg">
            {value} <span className="text-sm font-medium tracking-normal text-muted">{unit}</span>
          </div>
        ) : (
          <span className="shrink-0 font-mono text-xs text-muted">not created yet</span>
        )}
      </div>

      {hasData ? (
        <>
          <div
            role="img"
            aria-label={`Storage split: ${SEGMENTS.map((s) => `${s.abbr ?? s.label.toLowerCase()} ${formatBytes(db[s.key])}`).join(', ')}`}
            className="flex h-2.5 gap-0.5 overflow-hidden rounded-full bg-line"
          >
            {SEGMENTS.map((s) =>
              db[s.key] ? (
                <div
                  key={s.key}
                  className={cn('h-full min-w-1', s.color)}
                  style={{ flex: `${db[s.key]} 1 0` }}
                />
              ) : null
            )}
          </div>
          <ul className="flex flex-col">
            {SEGMENTS.map((s) => (
              <li
                key={s.key}
                className="grid grid-cols-[10px_minmax(0,1fr)_auto] items-center gap-3 border-b border-line py-2.5 text-[13px] last:border-0"
              >
                <span className={cn('size-2.5 rounded-[3px]', s.color)} />
                <span>
                  {s.label}
                  {s.abbr && <span className="text-muted"> ({s.abbr})</span>}
                </span>
                <span className="tnum text-muted">{formatBytes(db[s.key])}</span>
              </li>
            ))}
          </ul>
          <div
            role={disk && !disk.ok ? 'alert' : undefined}
            className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-control border border-line bg-bg px-3.5 py-3 text-[13px] light:bg-surface-2"
          >
            {disk && (
              <span className={cn('inline-flex items-center gap-2.5', !disk.ok && 'text-danger')}>
                <span
                  className={cn('size-2 rounded-full', disk.ok ? 'bg-success' : 'bg-danger-fill')}
                />
                {disk.ok ? 'Disk healthy · no write errors' : disk.message}
              </span>
            )}
            {db.mtimeMs ? (
              <span className={cn('text-xs text-muted', disk && 'ml-auto')}>
                Written {formatRelativeTime(db.mtimeMs)}
              </span>
            ) : null}
          </div>
        </>
      ) : (
        <p className="rounded-control border border-dashed border-line px-4 py-6 text-center text-sm text-muted">
          The database appears here after the first start — SQLite creates the file at the
          configured data path.
        </p>
      )}
    </Card>
  );
}
