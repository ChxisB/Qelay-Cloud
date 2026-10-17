import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { CopyButton } from '@/components/ui/CopyButton';
import { formatMs, formatNumber } from '@/lib/format';
import { fmtRate, type RunRecord } from './engine';

/** Recent runs, newest first, with copy + JSON export for comparison. */
export function RunHistory({ history, onClear }: { history: RunRecord[]; onClear: () => void }) {
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
      <div className="flex items-center justify-between border-b border-line px-5 py-3">
        <h3 className="text-base font-semibold text-fg">Run history</h3>
        <div className="flex items-center gap-2">
          <CopyButton value={json} />
          <Button size="sm" variant="ghost" onClick={download}>
            Export JSON
          </Button>
          <Button size="sm" variant="ghost" onClick={onClear}>
            Clear
          </Button>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left eyebrow text-muted light:bg-surface-2">
              <th className="px-4 py-2 font-semibold">Mode</th>
              <th className="px-4 py-2 text-right font-semibold">Prod</th>
              <th className="px-4 py-2 text-right font-semibold">Wkr</th>
              <th className="px-4 py-2 text-right font-semibold">Pushed</th>
              <th className="px-4 py-2 text-right font-semibold">Done</th>
              <th className="px-4 py-2 text-right font-semibold">Push/s</th>
              <th className="px-4 py-2 text-right font-semibold">Done/s</th>
              <th className="px-4 py-2 text-right font-semibold">p95</th>
              <th className="px-4 py-2 text-right font-semibold">Dur</th>
            </tr>
          </thead>
          <tbody>
            {history.map((r) => (
              <tr key={r.id} className="border-b border-line last:border-0 hover:bg-surface-2/40">
                <td className="px-4 py-2 capitalize text-muted">{r.mode}</td>
                <td className="px-4 py-2 text-right tnum text-muted">{r.producers}</td>
                <td className="px-4 py-2 text-right tnum text-muted">{r.workers}</td>
                <td className="px-4 py-2 text-right tnum text-fg">{formatNumber(r.pushed)}</td>
                <td className="px-4 py-2 text-right tnum text-success">
                  {formatNumber(r.completed)}
                </td>
                <td className="px-4 py-2 text-right tnum text-fg">{fmtRate(r.pushPerSec)}/s</td>
                <td className="px-4 py-2 text-right tnum text-success">
                  {fmtRate(r.donePerSec)}/s
                </td>
                <td className="px-4 py-2 text-right tnum text-muted">{formatMs(r.p95)}</td>
                <td className="px-4 py-2 text-right tnum text-muted">{formatMs(r.durationMs)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
