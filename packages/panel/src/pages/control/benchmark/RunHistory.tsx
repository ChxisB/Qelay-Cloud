import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { CopyButton } from '@/components/ui/CopyButton';
import { Table, TableScroll, Td, Th, THead, Tr } from '@/components/ui/Table';
import { formatMs, formatNumber } from '@/lib/format';
import { useRowArrivals } from '@/lib/useRowArrivals';
import { fmtRate, type RunRecord } from './engine';

/** Recent runs, newest first, with copy + JSON export for comparison. */
export function RunHistory({ history, onClear }: { history: RunRecord[]; onClear: () => void }) {
  // The runs there when the page opens rise in a stagger; a run that finishes later slides in on its own.
  const arrival = useRowArrivals(
    'history',
    history.map((r) => String(r.id)),
    true
  );
  if (!history.length) return null;
  const json = JSON.stringify(history, null, 2);
  const download = () => {
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `benchmark-history-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Card padded={false} className="mt-6 overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-4">
        <h3 className="m-0 text-lg font-bold text-fg">Run history</h3>
        <div className="flex items-center gap-2">
          <CopyButton value={json} />
          <Button size="sm" onClick={download}>
            Export JSON
          </Button>
          <Button size="sm" onClick={onClear}>
            Clear
          </Button>
        </div>
      </div>
      <TableScroll>
        <Table>
          <THead>
            <tr>
              <Th>Mode</Th>
              <Th right>Prod</Th>
              <Th right>Wkr</Th>
              <Th right>Pushed</Th>
              <Th right>Done</Th>
              <Th right>Push/s</Th>
              <Th right>Done/s</Th>
              <Th right>p95</Th>
              <Th right>Dur</Th>
            </tr>
          </THead>
          <tbody>
            {history.map((r, i) => (
              <Tr key={r.id} dense arrive={arrival(String(r.id), i)}>
                <Td className="capitalize text-muted">{r.mode}</Td>
                <Td className="text-right tnum text-muted">{r.producers}</Td>
                <Td className="text-right tnum text-muted">{r.workers}</Td>
                <Td className="text-right tnum">{formatNumber(r.pushed)}</Td>
                <Td className="text-right tnum text-success">{formatNumber(r.completed)}</Td>
                <Td className="text-right tnum">{fmtRate(r.pushPerSec)}/s</Td>
                <Td className="text-right tnum text-success">{fmtRate(r.donePerSec)}/s</Td>
                <Td className="text-right tnum text-muted">{formatMs(r.p95)}</Td>
                <Td className="text-right tnum text-muted">{formatMs(r.durationMs)}</Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      </TableScroll>
    </Card>
  );
}
