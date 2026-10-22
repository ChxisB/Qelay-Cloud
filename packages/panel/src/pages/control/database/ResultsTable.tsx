import { useMemo } from 'react';
import { Button } from '@/components/ui/Button';
import { Table, TableScroll, Td, Th, THead, Tr } from '@/components/ui/Table';
import { cn } from '@/lib/cn';
import type { ColMeta, Sort } from './types';

function Cell({ value, align }: { value: unknown; align: 'left' | 'right' }) {
  if (value == null) return <span className="italic text-muted">NULL</span>;
  const s = typeof value === 'string' ? value : String(value);
  return (
    <span
      className={cn('block max-w-[24rem] truncate', align === 'right' && 'text-right tabular-nums')}
      title={s}
    >
      {s}
    </span>
  );
}

export function ResultsTable({
  columns,
  rows,
  truncatedCells,
  colMeta,
  sort,
  onSort,
  onRowClick,
  dimmed,
}: {
  columns: string[];
  rows: unknown[][];
  truncatedCells?: boolean[][];
  colMeta?: ColMeta;
  sort?: Sort;
  onSort?: (col: string) => void;
  onRowClick?: (index: number) => void;
  dimmed?: boolean;
}) {
  // A column is right-aligned when every non-null cell is a number, or its
  // declared type is numeric (covers bigints serialized as strings).
  const numericCols = useMemo(
    () =>
      columns.map((c, ci) => {
        const t = colMeta?.[c]?.type?.toUpperCase() ?? '';
        if (/INT|REAL|NUM|DEC|DOUB|FLOA/.test(t)) return true;
        let sawValue = false;
        for (const r of rows) {
          const v = r[ci];
          if (v == null) continue;
          sawValue = true;
          if (typeof v !== 'number') return false;
        }
        return sawValue;
      }),
    [columns, rows, colMeta]
  );

  return (
    <TableScroll
      className={cn(
        'max-h-[70vh] overflow-y-auto rounded-card border border-line bg-surface transition-opacity',
        dimmed && 'pointer-events-none opacity-50'
      )}
    >
      <Table>
        <THead sticky>
          <tr>
            {onRowClick && (
              <Th>
                <span className="sr-only">Row actions</span>
              </Th>
            )}
            {columns.map((c, ci) => {
              const meta = colMeta?.[c];
              return (
                <Th
                  key={c}
                  right={numericCols[ci]}
                  aria-sort={
                    sort?.col === c
                      ? sort.dir === 'asc'
                        ? 'ascending'
                        : 'descending'
                      : onSort
                        ? 'none'
                        : undefined
                  }
                >
                  {onSort ? (
                    <button
                      type="button"
                      onClick={() => onSort(c)}
                      aria-label={`Sort by ${c}`}
                      className={cn(
                        'inline-flex min-h-8 items-center gap-1.5 rounded-control uppercase transition-colors hover:text-fg',
                        sort?.col === c ? 'text-fg' : 'text-muted'
                      )}
                    >
                      {c}
                      {meta?.primaryKey && (
                        <span
                          title="Primary key: the column that identifies each row"
                          className="rounded-control bg-slate-tint px-1.5 py-0.5 text-[12px] font-bold text-fg"
                        >
                          PK
                        </span>
                      )}
                      <span aria-hidden="true">
                        {sort?.col === c ? (sort.dir === 'asc' ? '▲' : '▼') : '↕'}
                      </span>
                    </button>
                  ) : (
                    c
                  )}
                </Th>
              );
            })}
          </tr>
        </THead>
        <tbody>
          {rows.map((r, ri) => (
            <Tr
              // Rows are positional within one immutable result page.
              // oxlint-disable-next-line react/no-array-index-key -- rows have no stable id
              key={ri}
              dense
              className="font-mono text-[13px]"
            >
              {onRowClick && (
                <Td className="whitespace-nowrap">
                  <Button
                    size="sm"
                    aria-label={`View row ${ri + 1} details`}
                    onClick={() => onRowClick(ri)}
                    className="font-sans"
                  >
                    View
                  </Button>
                </Td>
              )}
              {r.map((v, ci) => (
                <Td
                  // oxlint-disable-next-line react/no-array-index-key -- cells are positional
                  key={ci}
                  className="whitespace-nowrap text-muted"
                >
                  <div className="flex items-center gap-1">
                    <Cell value={v} align={numericCols[ci] ? 'right' : 'left'} />
                    {truncatedCells?.[ri]?.[ci] && (
                      <span
                        title="Value truncated — use the row's View action to read it in full"
                        className="shrink-0 rounded-control bg-slate-tint px-1.5 text-[12px] font-bold text-warning"
                      >
                        …
                      </span>
                    )}
                  </div>
                </Td>
              ))}
            </Tr>
          ))}
        </tbody>
      </Table>
    </TableScroll>
  );
}
