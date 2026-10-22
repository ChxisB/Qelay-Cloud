import type { ChangeEvent } from 'react';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import { Field, Input, SegmentedControl, Toggle } from '@/components/ui/form';
import { StatusGlyph } from '@/components/ui/StatusBadge';
import { cn } from '@/lib/cn';
import { formatNumber } from '@/lib/format';
import { LIMITS } from './engine';
import { BENCHMARK_MODES, type BenchmarkDraft, type BenchmarkNumKey } from './pageModel';

export function BenchmarkConfiguration({
  draft,
  active,
  cleaning,
  cleanResult,
  overLimit,
  setField,
  numberInput,
  onClean,
}: {
  draft: BenchmarkDraft;
  active: boolean;
  cleaning: boolean;
  cleanResult: { remaining: number } | { error: string } | null;
  /** The number fields whose value is above their limit. */
  overLimit: readonly BenchmarkNumKey[];
  setField: <K extends keyof BenchmarkDraft>(key: K, value: BenchmarkDraft[K]) => void;
  numberInput: (key: BenchmarkNumKey) => (event: ChangeEvent<HTMLInputElement>) => void;
  onClean: () => void;
}) {
  const invalid = (key: BenchmarkNumKey) => (overLimit.includes(key) ? true : undefined);
  return (
    <Card className="lg:col-span-1">
      <CardHeader title="Configuration" />
      <div className="flex flex-col gap-3">
        <Field
          label="Dedicated queue"
          hint="Made up for this test, so it cannot touch your real queues."
        >
          <Input
            name="benchmark-queue"
            autoComplete="off"
            value={draft.queue}
            readOnly
            aria-readonly="true"
          />
        </Field>
        <Field
          label="Mode"
          hint={
            draft.mode === 'count'
              ? 'Push a fixed number of jobs.'
              : 'Run producers + workers for a fixed time.'
          }
        >
          <SegmentedControl
            options={BENCHMARK_MODES}
            value={draft.mode}
            onChange={(mode) => setField('mode', mode)}
            disabled={active}
          />
        </Field>
        {draft.mode === 'count' ? (
          <Field label="Total jobs" hint={`max ${formatNumber(LIMITS.total)}`}>
            <Input
              name="benchmark-total"
              aria-invalid={invalid('total')}
              autoComplete="off"
              type="number"
              min={1}
              max={LIMITS.total}
              value={draft.total}
              disabled={active}
              onChange={numberInput('total')}
            />
          </Field>
        ) : (
          <Field label="Duration (s)" hint={`max ${LIMITS.durationS}s`}>
            <Input
              name="benchmark-duration-seconds"
              aria-invalid={invalid('durationS')}
              autoComplete="off"
              type="number"
              min={1}
              max={LIMITS.durationS}
              value={draft.durationS}
              disabled={active}
              onChange={numberInput('durationS')}
            />
          </Field>
        )}
        <div className="mt-1 text-[13px] font-extrabold text-fg">Producers</div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Producers" hint={`parallel, max ${LIMITS.producers}`}>
            <Input
              name="benchmark-producers"
              aria-invalid={invalid('producers')}
              autoComplete="off"
              type="number"
              min={1}
              max={LIMITS.producers}
              value={draft.producers}
              disabled={active}
              onChange={numberInput('producers')}
            />
          </Field>
          <Field label="Push batch" hint={`jobs/req, max ${LIMITS.batch}`}>
            <Input
              name="benchmark-push-batch"
              aria-invalid={invalid('batch')}
              autoComplete="off"
              type="number"
              min={1}
              max={LIMITS.batch}
              value={draft.batch}
              disabled={active}
              onChange={numberInput('batch')}
            />
          </Field>
          <Field label="Payload" hint={`bytes/job, max ${formatNumber(LIMITS.payload)}`}>
            <Input
              name="benchmark-payload-bytes"
              aria-invalid={invalid('payload')}
              autoComplete="off"
              type="number"
              min={0}
              max={LIMITS.payload}
              value={draft.payload}
              disabled={active}
              onChange={numberInput('payload')}
            />
          </Field>
        </div>
        <div className="mt-1 text-[13px] font-extrabold text-fg">Workers (simulated)</div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Workers" hint={`0 = produce only, max ${LIMITS.workers}`}>
            <Input
              name="benchmark-workers"
              aria-invalid={invalid('workers')}
              autoComplete="off"
              type="number"
              min={0}
              max={LIMITS.workers}
              value={draft.workers}
              disabled={active}
              onChange={numberInput('workers')}
            />
          </Field>
          <Field label="Pull batch" hint={`jobs/pull, max ${LIMITS.workerBatch}`}>
            <Input
              name="benchmark-pull-batch"
              aria-invalid={invalid('workerBatch')}
              autoComplete="off"
              type="number"
              min={1}
              max={LIMITS.workerBatch}
              value={draft.workerBatch}
              disabled={active}
              onChange={numberInput('workerBatch')}
            />
          </Field>
          <Field label="Process (ms)" hint="simulated work per pull">
            <Input
              name="benchmark-process-ms"
              aria-invalid={invalid('processMs')}
              autoComplete="off"
              type="number"
              min={0}
              max={LIMITS.processMs}
              value={draft.processMs}
              disabled={active}
              onChange={numberInput('processMs')}
            />
          </Field>
        </div>
        <ToggleRow
          label="Durable (fsync each job)"
          checked={draft.durable}
          active={active}
          onChange={(durable) => setField('durable', durable)}
        />
        <ToggleRow
          label="Remove on complete"
          checked={draft.removeOnComplete}
          active={active}
          onChange={(removeOnComplete) => setField('removeOnComplete', removeOnComplete)}
        />
        <div className="flex items-center gap-3 pt-1">
          <Button size="sm" disabled={active || cleaning} onClick={onClean}>
            {cleaning ? 'Cleaning…' : 'Clean queue'}
          </Button>
          {cleanResult &&
            ('error' in cleanResult ? (
              <span
                role="alert"
                className="motion-arrive inline-flex items-center gap-1.5 text-[13px] font-bold text-danger"
              >
                <StatusGlyph small state="failed" />
                Clean unverified — {cleanResult.error}
              </span>
            ) : (
              <span
                role="status"
                className={cn(
                  'motion-arrive inline-flex items-center gap-1.5 text-[13px] font-bold',
                  cleanResult.remaining > 0 ? 'text-warning' : 'text-success'
                )}
              >
                <StatusGlyph small state={cleanResult.remaining > 0 ? 'delayed' : 'completed'} />
                {cleanResult.remaining > 0
                  ? `Cleaned — ${formatNumber(cleanResult.remaining)} active job(s) remain (requeued after the stall timeout)`
                  : 'Cleaned — 0 jobs remain'}
              </span>
            ))}
        </div>
      </div>
    </Card>
  );
}

function ToggleRow({
  label,
  checked,
  active,
  onChange,
}: {
  label: string;
  checked: boolean;
  active: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <Toggle checked={checked} onChange={onChange} disabled={active} label={label} />
      <span className="text-sm font-medium text-fg">{label}</span>
    </div>
  );
}
