import { type ReactNode, useMemo } from 'react';
import { type AlertRule, METRIC_LABELS } from '@/components/dashboard/stores/alertsStore';
import { IconButton } from '@/components/ui/Button';
import { Toggle } from '@/components/ui/form';
import { IconTrash } from '@/components/ui/icons';
import { StatusPill } from '@/components/ui/StatusBadge';
import { Table, TableScroll, Td, Th, THead, Tr } from '@/components/ui/Table';
import { Tag } from '@/components/ui/Tag';
import type { Breach } from '@/lib/alertEngineMetrics';
import { cn } from '@/lib/cn';
import { formatRelativeTime } from '@/lib/format';
import { useFirstLoad } from '@/lib/useFirstLoad';
import { useLeavers } from '@/lib/useLeavers';

/**
 * A row rises when it comes in: the first load in a stagger, a later one at once. A row that has just gone stays for
 * its 180ms leave. When none are left the table gives way to `empty`.
 */
const place = (first: boolean, index: number, leaving: boolean) =>
  leaving ? undefined : first ? index : 0;

/** The rules that are over their threshold now. A rule that stops firing, or is switched off, leaves its row. */
export function FiringTable({ breaches, empty }: { breaches: Breach[]; empty: ReactNode }) {
  const first = useFirstLoad(breaches.length > 0);
  // `useLeavers` compares the list by identity, so it must not be a new array on every render.
  const items = useMemo(() => breaches.map((b) => ({ ...b, id: b.ruleId })), [breaches]);
  const shown = useLeavers(items);
  if (shown.length === 0) return empty;
  return (
    <TableScroll className="rounded-card border border-line bg-surface">
      <Table className="min-w-[560px]">
        <THead>
          <tr>
            <Th>Rule</Th>
            <Th>Condition</Th>
            <Th>Queue</Th>
            <Th right>Current</Th>
            <Th right>Since</Th>
          </tr>
        </THead>
        <tbody>
          {shown.map(({ item: b, leaving }, index) => (
            <Tr
              key={b.ruleId}
              status="bad"
              arrive={place(first, index, leaving)}
              inert={leaving}
              className={cn(leaving && 'motion-leave')}
            >
              <Td>
                <div className="font-bold">{b.ruleName}</div>
                <div className="mt-1">
                  <StatusPill state="failed">Firing</StatusPill>
                </div>
              </Td>
              <Td className="text-muted">
                {b.metricLabel} {b.operator}{' '}
                <span className="font-bold text-fg">{b.threshold}</span>
              </Td>
              <Td className="text-muted">{b.queue || 'All queues'}</Td>
              <Td className="text-right tnum font-bold text-danger">
                {Math.round(b.value * 100) / 100}
              </Td>
              <Td className="text-right text-muted">{formatRelativeTime(b.at)}</Td>
            </Tr>
          ))}
        </tbody>
      </Table>
    </TableScroll>
  );
}

/** Every rule. The switch says its state in a word and is named for its rule; delete asks first (the page's job). */
export function RulesTable({
  rules,
  onToggle,
  onDelete,
  empty,
}: {
  rules: AlertRule[];
  onToggle: (rule: AlertRule) => void;
  onDelete: (rule: AlertRule) => void;
  empty: ReactNode;
}) {
  const first = useFirstLoad(rules.length > 0);
  const shown = useLeavers(rules);
  if (shown.length === 0) return empty;
  return (
    <TableScroll className="rounded-card border border-line bg-surface">
      <Table className="min-w-[560px]">
        <THead>
          <tr>
            <Th>Rule</Th>
            <Th>Condition</Th>
            <Th>Queue</Th>
            <Th>Delivery</Th>
            <Th>Status</Th>
            <Th className="w-12" aria-label="Actions" />
          </tr>
        </THead>
        <tbody>
          {shown.map(({ item: r, leaving }, index) => (
            <Tr
              key={r.id}
              arrive={place(first, index, leaving)}
              inert={leaving}
              className={cn(leaving && 'motion-leave')}
            >
              <Td className="font-bold">{r.name}</Td>
              <Td className="text-muted">
                {METRIC_LABELS[r.metric]} {r.operator}{' '}
                <span className="font-bold text-fg">{r.threshold}</span>
              </Td>
              <Td className="text-muted">{r.queue || 'All queues'}</Td>
              <Td>
                <Tag>Browser</Tag>
              </Td>
              <Td>
                <div className="flex items-center gap-2">
                  <Toggle
                    checked={r.enabled}
                    onChange={() => onToggle(r)}
                    label={`${r.enabled ? 'Disable' : 'Enable'} rule ${r.name}`}
                  />
                  <span className="text-[13px] text-muted">
                    {r.enabled ? 'Enabled' : 'Disabled'}
                  </span>
                </div>
              </Td>
              <Td className="text-right">
                <IconButton aria-label={`Delete rule ${r.name}`} onClick={() => onDelete(r)}>
                  <IconTrash className="size-3.5" />
                </IconButton>
              </Td>
            </Tr>
          ))}
        </tbody>
      </Table>
    </TableScroll>
  );
}
