import { useMemo } from 'react';
import { IconButton } from '@/components/ui/Button';
import { Figure } from '@/components/ui/Figure';
import { IconTrash } from '@/components/ui/icons';
import { ConnectionLine } from '@/components/ui/nodegraph/ConnectionLine';
import { Pagination } from '@/components/ui/Pagination';
import { Table, TableScroll, Td, Th, THead, Tr } from '@/components/ui/Table';
import type { CronFull } from '@/lib/bqTypes';
import { cn } from '@/lib/cn';
import { formatDateTime } from '@/lib/format';
import { useRises } from '@/lib/useChangeFlash';
import { useFirstLoad } from '@/lib/useFirstLoad';
import { useLeavers } from '@/lib/useLeavers';

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
  const first = useFirstLoad(crons.length > 0);
  // `useLeavers` compares the list by identity, so it must not be a new array on every render.
  const visible = useMemo(
    () =>
      crons
        .slice(page * CRON_PAGE_SIZE, page * CRON_PAGE_SIZE + CRON_PAGE_SIZE)
        .map((cron) => ({ ...cron, id: cron.name })),
    [crons, page]
  );
  const rows = useLeavers(visible);
  return (
    <>
      <TableScroll className="rounded-card border border-line bg-surface">
        <Table className="min-w-[640px]">
          <THead>
            <tr>
              <Th>Name</Th>
              <Th>Queue</Th>
              <Th>Job name</Th>
              <Th>Schedule</Th>
              <Th>Next Run</Th>
              <Th right>Runs</Th>
              {canRemove && <Th className="w-12" aria-label="Actions" />}
            </tr>
          </THead>
          <tbody>
            {rows.map(({ item: cron, leaving }, index) => (
              <CronRow
                key={cron.name}
                cron={cron}
                leaving={leaving}
                arrive={first && !leaving ? index : undefined}
                removing={removing.has(cron.name)}
                canRemove={canRemove}
                onRemove={onRemove}
              />
            ))}
          </tbody>
        </Table>
      </TableScroll>
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

/** The queue cell draws a short line from the schedule to its queue; it sends one comet each time the run count goes up. */
function CronRow({
  cron,
  leaving,
  arrive,
  removing,
  canRemove,
  onRemove,
}: {
  cron: CronFull;
  leaving: boolean;
  arrive: number | undefined;
  removing: boolean;
  canRemove: boolean;
  onRemove: (name: string) => void;
}) {
  const pulse = useRises(cron.executions);
  return (
    <Tr arrive={arrive} inert={leaving} className={cn(leaving && 'motion-leave')}>
      <Td className="font-bold text-fg">{cron.name}</Td>
      <Td className="font-mono text-xs text-muted">
        <div className="flex items-center gap-6 pl-4">
          <span aria-hidden="true" className="inline-block h-3 w-2">
            <ConnectionLine state="active" pulse={pulse} />
          </span>
          {cron.queue}
        </div>
      </Td>
      <Td className="font-mono text-xs text-muted">{cron.jobName ?? 'default'}</Td>
      <Td className="font-mono text-xs text-muted">
        {cron.schedule ?? (cron.repeatEvery ? `every ${cron.repeatEvery}ms` : '—')}
      </Td>
      <Td className="text-muted">{formatDateTime(cron.nextRun)}</Td>
      <Td className="text-right tnum text-muted">
        <Figure value={cron.executions} />
      </Td>
      {canRemove && (
        <Td className="text-right">
          <IconButton
            size="sm"
            aria-label={`Delete cron ${cron.name}`}
            disabled={removing}
            onClick={() => onRemove(cron.name)}
          >
            <IconTrash className="size-4" />
          </IconButton>
        </Td>
      )}
    </Tr>
  );
}
