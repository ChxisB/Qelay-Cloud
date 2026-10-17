import { IconButton } from '@/components/ui/Button';
import { IconTrash } from '@/components/ui/icons';
import { Pagination } from '@/components/ui/Pagination';
import type { CronFull } from '@/lib/bqTypes';
import { formatDateTime, formatNumber } from '@/lib/format';

export const CRON_PAGE_SIZE = 15;

export function CronTable({
  crons,
  page,
  removing,
  canRemove,
  onPageChange,
  onRemove,
}: {
  crons: CronFull[];
  page: number;
  removing: ReadonlySet<string>;
  /** False for a viewer: the delete column is left out. */
  canRemove: boolean;
  onPageChange: (page: number) => void;
  onRemove: (name: string) => void;
}) {
  const visible = crons.slice(page * CRON_PAGE_SIZE, page * CRON_PAGE_SIZE + CRON_PAGE_SIZE);
  return (
    <>
      <div className="overflow-x-auto rounded-card border border-line bg-surface">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left eyebrow text-muted light:bg-surface-2">
              <th scope="col" className="px-4 py-2.5 font-semibold">
                Name
              </th>
              <th scope="col" className="px-4 py-2.5 font-semibold">
                Queue
              </th>
              <th scope="col" className="px-4 py-2.5 font-semibold">
                Job name
              </th>
              <th scope="col" className="px-4 py-2.5 font-semibold">
                Schedule
              </th>
              <th scope="col" className="px-4 py-2.5 font-semibold">
                Next Run
              </th>
              <th scope="col" className="px-4 py-2.5 text-right font-semibold">
                Runs
              </th>
              {canRemove && <th scope="col" className="w-12 px-4 py-2.5" />}
            </tr>
          </thead>
          <tbody>
            {visible.map((cron) => (
              <tr
                key={cron.name}
                className="border-b border-line last:border-0 hover:bg-surface-2/40"
              >
                <td className="px-4 py-2.5 font-medium text-fg">{cron.name}</td>
                <td className="px-4 py-2.5 font-mono text-xs text-muted">{cron.queue}</td>
                <td className="px-4 py-2.5 font-mono text-xs text-muted">
                  {cron.jobName ?? 'default'}
                </td>
                <td className="px-4 py-2.5 font-mono text-xs text-muted">
                  {cron.schedule ?? (cron.repeatEvery ? `every ${cron.repeatEvery}ms` : '—')}
                </td>
                <td className="px-4 py-2.5 text-faint">{formatDateTime(cron.nextRun)}</td>
                <td className="px-4 py-2.5 text-right tnum text-muted">
                  {formatNumber(cron.executions)}
                </td>
                {canRemove && (
                  <td className="px-4 py-2.5 text-right">
                    <IconButton
                      aria-label={`Delete cron ${cron.name}`}
                      disabled={removing.has(cron.name)}
                      onClick={() => onRemove(cron.name)}
                    >
                      <IconTrash className="size-3.5" />
                    </IconButton>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Pagination
        page={page}
        pageSize={CRON_PAGE_SIZE}
        total={crons.length}
        onPageChange={onPageChange}
        label="crons"
      />
    </>
  );
}
