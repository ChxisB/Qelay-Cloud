import { useEffect, useState } from 'react';
import { confirmInPage } from '@/components/dashboard/stores/confirmStore';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import { Facts } from '@/components/ui/Facts';
import { Field, FieldAction, FormRow, Input } from '@/components/ui/form';
import { ReadFirstCard, Value } from '@/components/ui/ReadFirstCard';
import { bq } from '@/lib/bq';
import type { DlqConfig } from '@/lib/bqTypes';
import { useCanOperate } from '@/lib/capabilities/useCapabilities';
import { formatDuration, formatNumber } from '@/lib/format';
import {
  assertConfigMutationResponse,
  type DlqRetentionDraft,
  dlqRetentionPayload,
  retentionDraft,
} from './configModel';
import { useConfigSaveGuard, useSyncedConfig } from './configState';

const DAY_MS = 86_400_000;

const keptFor = (ms: number | null) =>
  ms === null
    ? 'For ever'
    : ms % DAY_MS === 0
      ? `${ms / DAY_MS} ${ms === DAY_MS ? 'day' : 'days'}`
      : formatDuration(ms);

const AUTO_RETRY = 'No, they stay in the failed list until someone retries them';

/** Whether saving `next` can delete failed jobs that are kept now: a shorter age or a lower count. */
const shrinks = (config: DlqConfig, next: Pick<DlqConfig, 'maxAge' | 'maxEntries'>) =>
  next.maxEntries < config.maxEntries ||
  (next.maxAge !== null && (config.maxAge === null || next.maxAge < config.maxAge));

/** The same facts for someone who may not change them. */
function DlqFacts({ config }: { config: DlqConfig }) {
  return (
    <Card>
      <CardHeader
        title="Failed job handling"
        sub="What happens to a job once it has failed all of its attempts. An operator can change how long they are kept."
      />
      <Facts
        items={[
          {
            label: 'Retry failed jobs automatically',
            value: config.autoRetry ? 'On' : AUTO_RETRY,
          },
          { label: 'Failed jobs are kept for', value: keptFor(config.maxAge) },
          {
            label: 'Most failed jobs kept',
            value: `${formatNumber(config.maxEntries)}, the oldest go first`,
          },
        ]}
      />
    </Card>
  );
}

/**
 * What happens to a job that has failed all of its attempts, and how long the failed list keeps them. An operator
 * sets the two retention limits here; a viewer sees them. Automatic retry is not offered: failed jobs are put
 * back by hand or in bulk from the Dead letter queue page.
 */
export function DlqConfigForm({
  queue,
  config,
  onSaved,
}: {
  queue: string;
  config: DlqConfig;
  onSaved: () => void | Promise<void>;
}) {
  const canOperate = useCanOperate();
  // The synced draft follows the server's value when a poll or another operator changes it.
  const [draft, setDraft, beginSave] = useSyncedConfig<DlqRetentionDraft>(retentionDraft(config));
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const save = useConfigSaveGuard(`dlq-config:${queue}`);
  // A target change clears errors from the previous target.
  useEffect(() => setError(null), [save.scopeKey]);
  if (!canOperate) return <DlqFacts config={config} />;

  const payload = dlqRetentionPayload(draft);
  const unchanged =
    payload.ok &&
    payload.value.maxAge === config.maxAge &&
    payload.value.maxEntries === config.maxEntries;
  const submit = async () => {
    if (!payload.ok || unchanged) return;
    if (
      shrinks(config, payload.value) &&
      !(await confirmInPage({
        question: `Delete the failed jobs of "${queue}" over the new limit?`,
        confirmLabel: 'Save and delete',
        danger: true,
        detail:
          'Failed jobs older than the new age, or beyond the new count, are deleted for good, the oldest first. A failed job that a flow still waits on is kept.',
      }))
    ) {
      return;
    }
    const lease = save.start();
    if (!lease) return;
    try {
      setError(null);
      const markSaved = beginSave();
      const response = await bq.setDlqConfig(queue, payload.value);
      assertConfigMutationResponse(response, '/dlq-config');
      if (!lease.isCurrent()) return;
      markSaved(draft);
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
      title="Failed job handling"
      sub="What happens to a job once it has failed all of its attempts, and how long the failed list keeps it."
      open={open}
      onOpenChange={setOpen}
      summary={
        <>
          Failed jobs are kept{' '}
          {config.maxAge === null ? (
            <Value>for ever</Value>
          ) : (
            <>
              for <Value>{keptFor(config.maxAge)}</Value>
            </>
          )}
          , and at most <Value>{formatNumber(config.maxEntries)}</Value> are kept. The oldest go
          first.
          {save.saved && <span className="ml-2 font-semibold text-success">Saved ✓</span>}
        </>
      }
      facts={<Facts items={[{ label: 'Retry failed jobs automatically', value: AUTO_RETRY }]} />}
    >
      <FormRow>
        <div className="min-w-56 flex-1">
          <Field
            label="Keep failed jobs for (days)"
            hint="Leave blank to keep them for ever. Part days work, for example 0.5."
          >
            <Input
              name="dlq-max-age-days"
              autoComplete="off"
              type="number"
              inputMode="decimal"
              min={0}
              step="any"
              value={draft.days}
              onChange={(event) => setDraft({ ...draft, days: event.target.value })}
            />
          </Field>
        </div>
        <div className="min-w-56 flex-1">
          <Field label="Most failed jobs kept" hint="When there are more, the oldest are deleted.">
            <Input
              name="dlq-max-entries"
              autoComplete="off"
              type="number"
              inputMode="numeric"
              min={1}
              max={Number.MAX_SAFE_INTEGER}
              step={1}
              value={draft.maxEntries}
              onChange={(event) => setDraft({ ...draft, maxEntries: event.target.value })}
            />
          </Field>
        </div>
        <FieldAction>
          <Button
            variant="primary"
            disabled={save.saving || !payload.ok || unchanged}
            onClick={submit}
          >
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
