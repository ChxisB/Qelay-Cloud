import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Facts } from '@/components/ui/Facts';
import { Field, FieldAction, FormRow, Input } from '@/components/ui/form';
import { ReadFirstCard, Value } from '@/components/ui/ReadFirstCard';
import { bq } from '@/lib/bq';
import type { StallConfig } from '@/lib/bqTypes';
import { formatDuration, formatNumber } from '@/lib/format';
import { assertConfigMutationResponse, type StallDraft, stallConfigPayload } from './configModel';
import { useConfigSaveGuard, useSyncedConfig } from './configState';

export function StallForm({
  queue,
  config,
  onSaved,
}: {
  queue: string;
  config: StallConfig;
  onSaved: () => void | Promise<void>;
}) {
  const [draft, setDraft, beginSave] = useSyncedConfig<StallDraft>(config);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const save = useConfigSaveGuard(`stall-config:${queue}`);
  // A target change clears errors from the previous target.
  useEffect(() => setError(null), [save.scopeKey]);
  const payload = stallConfigPayload(draft);
  const submit = async () => {
    if (!payload.ok) return;
    const lease = save.start();
    if (!lease) return;
    try {
      setError(null);
      const markSaved = beginSave();
      const response = await bq.setStallConfig(queue, payload.value);
      assertConfigMutationResponse(response, '/stall-config');
      if (!lease.isCurrent()) return;
      markSaved(payload.value);
      await onSaved();
      save.showSaved(lease);
      setOpen(false);
    } catch (caught) {
      if (lease.isCurrent()) setError((caught as Error).message);
    } finally {
      save.finish(lease);
    }
  };
  return (
    <ReadFirstCard
      title="Stuck job detection"
      sub="A job is stuck when its worker stops responding. Qelay then puts it back in the queue so another worker can take it."
      open={open}
      onOpenChange={setOpen}
      summary={
        <>
          {config.maxStalls === 0 ? (
            <>
              A job can get stuck <Value>any number of times</Value> without being marked failed.
            </>
          ) : (
            <>
              A job that gets stuck <Value>{formatNumber(config.maxStalls)}</Value>{' '}
              {config.maxStalls === 1 ? 'time' : 'times'} is marked failed.
            </>
          )}
          {save.saved && <span className="ml-2 font-semibold text-success">Saved ✓</span>}
        </>
      }
      facts={
        <>
          <p className="mb-3 text-[13px] text-muted">Set by the server, shown for reference.</p>
          <Facts
            items={[
              { label: 'Stuck job check', value: config.enabled ? 'Always on' : 'Off' },
              {
                label: 'A worker counts as stuck after',
                value: `${formatDuration(config.stallInterval)} of silence`,
              },
              {
                label: 'Extra waiting time',
                value: config.gracePeriod === 0 ? 'None' : formatDuration(config.gracePeriod),
              },
            ]}
          />
        </>
      }
    >
      <FormRow>
        <div className="min-w-56 flex-1">
          <Field
            label="Most times a job can get stuck"
            hint="After that it is marked failed. 0 means no limit."
          >
            <Input
              name="stall-max-count"
              autoComplete="off"
              type="number"
              min={0}
              max={Number.MAX_SAFE_INTEGER}
              step={1}
              value={draft.maxStalls}
              onChange={(event) => setDraft({ ...draft, maxStalls: event.target.value })}
            />
          </Field>
        </div>
        <FieldAction>
          <Button variant="primary" disabled={save.saving || !payload.ok} onClick={submit}>
            Save
          </Button>
        </FieldAction>
      </FormRow>
      {!payload.ok && (
        <p role="alert" className="mt-3 text-[13px] font-semibold text-danger">
          {payload.error}
        </p>
      )}
      {error && (
        <p role="alert" className="mt-3 text-[13px] font-semibold text-danger">
          {error}
        </p>
      )}
    </ReadFirstCard>
  );
}
