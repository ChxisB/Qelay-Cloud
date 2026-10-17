import { Button } from '@/components/ui/Button';

export function JobsFooter({
  label,
  page,
  hasNext,
  onPage,
}: {
  label: string;
  page: number;
  hasNext: boolean;
  onPage: (page: number) => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2.5 border-t border-line px-4 py-3">
      <span className="text-[13px] text-muted tnum">{label}</span>
      <div className="flex items-center gap-2">
        <Button size="sm" disabled={page === 0} onClick={() => onPage(page - 1)}>
          Previous
        </Button>
        <Button size="sm" disabled={!hasNext} onClick={() => onPage(page + 1)}>
          Next
        </Button>
      </div>
    </div>
  );
}
