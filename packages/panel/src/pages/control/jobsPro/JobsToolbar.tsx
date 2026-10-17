import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/form';
import { IconDownload } from '@/components/ui/icons';
import { SearchField } from '@/components/ui/SearchField';
import type { QueueSummaryFull } from '@/lib/bqTypes';

export function JobsToolbar({
  queue,
  summary,
  search,
  canExport,
  onQueue,
  onSearch,
  onExport,
}: {
  queue: string;
  summary: QueueSummaryFull[];
  search: string;
  canExport: boolean;
  onQueue: (queue: string) => void;
  onSearch: (search: string) => void;
  onExport: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <div className="w-48">
        <Select
          value={queue}
          aria-label="Queue"
          name="jobs-queue"
          autoComplete="off"
          onChange={(event) => onQueue(event.target.value)}
        >
          {summary.map((item) => (
            <option key={item.name} value={item.name}>
              {item.name}
            </option>
          ))}
        </Select>
      </div>
      <SearchField
        containerClassName="min-w-56 flex-1 md:max-w-sm"
        value={search}
        onChange={(event) => onSearch(event.target.value)}
        placeholder="Filter by ID, name or data"
        aria-label="Filter this page by job ID, name or data"
        name="jobs-id-filter"
        autoComplete="off"
      />
      <Button variant="ghost" className="ml-auto" disabled={!canExport} onClick={onExport}>
        <IconDownload className="size-4" /> Export CSV
      </Button>
    </div>
  );
}
