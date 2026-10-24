import { type ReactNode, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import { Facts } from '@/components/ui/Facts';
import { Field, FieldAction, FormRow, Input, Select } from '@/components/ui/form';
import { ReadFirstCard, Value } from '@/components/ui/ReadFirstCard';
import { bq } from '@/lib/bq';
import type { QueuePolicy } from '@/lib/bqTypes';
import { useCanOperate } from '@/lib/capabilities/useCapabilities';
import { formatNumber } from '@/lib/format';
import { assertConfigMutationResponse, configSig } from './configModel';
import { useSyncedConfig } from './configState';
import { type PolicyDraft, policyDraft, policyPayload, spell } from './queueSettingModel';
import { useSettingSave } from './useSettingSave';

const TITLE = 'Retry policy';
const SUB = "What a job gets when it doesn't set its own attempts, retry delay or time limit.";
const NONE = 'No policy. Each job uses its own settings, or the service default.';

/** The settings as short phrases, ready to join into a sentence. */
function phrases(policy: QueuePolicy): Array<[string, ReactNode]> {
  const { attempts, backoff, timeout } = policy;
  const out: Array<[string, ReactNode]> = [];
  if (attempts !== undefined) {
    out.push([
      'attempts',
      <>
        <Value>{formatNumber(attempts)}</Value> {attempts === 1 ? 'attempt' : 'attempts'}
      </>,
    ]);
  }
  if (backoff?.type === 'fixed') {
    out.push([
      'backoff',
      <>
        a retry after <Value>{spell(backoff.delay)}</Value> each time
      </>,
    ]);
  } else if (backoff) {
    out.push([
      'backoff',
      <>
        a first retry after <Value>{spell(backoff.delay)}</Value>, doubling each time up to{' '}
        <Value>{spell(backoff.maxDelay ?? 3_600_000)}</Value>
      </>,
    ]);
  }
  if (timeout !== undefined) {
    out.push([
      'timeout',
      <>
        a time limit of <Value>{spell(timeout)}</Value>
      </>,
    ]);
  }
  return out;
}

function Sentence({ policy }: { policy: QueuePolicy | null }) {
  const parts = policy ? phrases(policy) : [];
  if (parts.length === 0) return <>{NONE}</>;
  return (
    <>
      A job that sets none of its own gets{' '}
      {parts.map(([key, part], index) => (
        <span key={key}>
          {index > 0 && (index === parts.length - 1 ? ' and ' : ', ')}
          {part}
        </span>
      ))}
      .
    </>
  );
}

/** The same facts for someone who may not change them. */
function PolicyFacts({ policy }: { policy: QueuePolicy | null }) {
  return (
    <Card>
      <CardHeader title={TITLE} sub={SUB} />
      <p className="text-[13px] leading-6 text-muted">
        <Sentence policy={policy} />
      </p>
    </Card>
  );
}

/** The queue's retry policy. An operator sets it here; a viewer reads it. Blank fields leave that setting to each job. */
export function PolicyForm({
  queue,
  policy,
  onSaved,
}: {
  queue: string;
  policy: QueuePolicy | null;
  onSaved: () => void | Promise<void>;
}) {
  const canOperate = useCanOperate();
  const [draft, setDraft, beginSave] = useSyncedConfig<PolicyDraft>(policyDraft(policy));
  const [open, setOpen] = useState(false);
  const { save, error, run } = useSettingSave(`policy:${queue}`);
  if (!canOperate) return <PolicyFacts policy={policy} />;

  const payload = policyPayload(draft);
  const unchanged = configSig(draft) === configSig(policyDraft(policy));
  const submit = async () => {
    if (!payload.ok || unchanged) return;
    const saved = await run(async () => {
      const markSaved = beginSave();
      assertConfigMutationResponse(await bq.setQueuePolicy(queue, payload.value), '/policy');
      markSaved(draft);
    }, onSaved);
    if (saved) setOpen(false);
  };
  const set = (patch: Partial<PolicyDraft>) => setDraft({ ...draft, ...patch });

  return (
    <ReadFirstCard
      title={TITLE}
      sub={SUB}
      open={open}
      onOpenChange={setOpen}
      summary={
        <>
          <Sentence policy={policy} />
          {save.saved && <span className="ml-2 font-semibold text-success">Saved ✓</span>}
        </>
      }
      facts={
        <Facts items={[{ label: 'A job’s own settings', value: 'Always win over the policy' }]} />
      }
    >
      <FormRow>
        <div className="min-w-40 flex-1">
          <Field label="Attempts" hint="Tries before a job fails for good.">
            <Input
              name="policy-attempts"
              autoComplete="off"
              type="number"
              inputMode="numeric"
              min={1}
              step={1}
              value={draft.attempts}
              onChange={(event) => set({ attempts: event.target.value })}
            />
          </Field>
        </div>
        <div className="min-w-48 flex-1">
          <Field label="Retry spacing">
            <Select
              name="policy-backoff"
              value={draft.backoff}
              onChange={(event) => set({ backoff: event.target.value as PolicyDraft['backoff'] })}
            >
              <option value="">Not set</option>
              <option value="fixed">The same each time</option>
              <option value="exponential">Doubling each time</option>
            </Select>
          </Field>
        </div>
        {draft.backoff !== '' && (
          <div className="min-w-40 flex-1">
            <Field label="Retry delay (seconds)" hint="Part seconds work, for example 0.5.">
              <Input
                name="policy-delay"
                autoComplete="off"
                type="number"
                inputMode="decimal"
                min={0}
                step="any"
                value={draft.delay}
                onChange={(event) => set({ delay: event.target.value })}
              />
            </Field>
          </div>
        )}
        {draft.backoff === 'exponential' && (
          <div className="min-w-40 flex-1">
            <Field label="Longest delay (seconds)" hint="Blank means 1 hour.">
              <Input
                name="policy-max-delay"
                autoComplete="off"
                type="number"
                inputMode="decimal"
                min={0}
                step="any"
                value={draft.maxDelay}
                onChange={(event) => set({ maxDelay: event.target.value })}
              />
            </Field>
          </div>
        )}
        <div className="min-w-40 flex-1">
          <Field label="Time limit (seconds)" hint="How long one attempt may run.">
            <Input
              name="policy-timeout"
              autoComplete="off"
              type="number"
              inputMode="decimal"
              min={0}
              step="any"
              value={draft.timeout}
              onChange={(event) => set({ timeout: event.target.value })}
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
      <p className="mt-3 text-[13px] text-muted">
        Leave every field blank to remove the policy. It applies to jobs added from now on.
      </p>
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
