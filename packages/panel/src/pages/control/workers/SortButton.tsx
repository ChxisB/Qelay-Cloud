import { cn } from '@/lib/cn';

/** Sortable column header: click toggles desc → asc; inherits the th typography. */
export function SortButton({
  label,
  active,
  onClick,
}: {
  label: string;
  active: 'asc' | 'desc' | null;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={`Sort by ${label}`}
      className={cn(
        'inline-flex items-center gap-1 uppercase transition-colors hover:text-fg',
        active ? 'text-fg' : 'text-muted'
      )}
    >
      {label}
      <span aria-hidden="true">{active === 'desc' ? '↓' : active === 'asc' ? '↑' : ''}</span>
    </button>
  );
}
