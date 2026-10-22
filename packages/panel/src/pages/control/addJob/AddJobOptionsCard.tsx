import { useState } from 'react';
import { Card, CardHeader } from '@/components/ui/Card';
import { Disclosure } from '@/components/ui/Disclosure';
import { Field, Input, Select } from '@/components/ui/form';
import { AddJobAdvanced } from './AddJobAdvanced';
import { NumberField, TextField, ToggleRow } from './AddJobFields';
import type { AddJobFormValues, SetAddJobValue } from './formModel';
import { MAX_DELAY_MS, MAX_DURATION_MS, MAX_GROUP_PRIORITY, OPTION_LABELS } from './options';

// Sized by the card, not the viewport: at lg the two cards sit side by side and each is narrow.
const FIELD_GRID = 'grid grid-cols-[repeat(auto-fit,minmax(11rem,1fr))] gap-4';

const filled = (...fields: Array<string | boolean>) => fields.some(Boolean);

export function AddJobOptionsCard({
  values,
  setValue,
}: {
  values: AddJobFormValues;
  setValue: SetAddJobValue;
}) {
  const grouped = Boolean(values.groupId.trim());
  // A job cloned with these set must show them, so each block starts open only when it has something in it.
  const [moreOpen] = useState(() =>
    filled(
      values.backoff,
      values.backoffType,
      values.timeout,
      values.ttl,
      values.jobId,
      values.removeOnComplete,
      values.removeOnFail,
      values.lifo
    )
  );
  const [advancedOpen] = useState(() =>
    filled(
      values.tags,
      values.groupId,
      values.groupMaxSize,
      values.uniqueKey,
      values.dependsOn,
      values.repeatText
    )
  );
  return (
    <Card>
      <CardHeader
        title="Options"
        sub="All optional. Leave a box empty to use the server's default."
      />
      <div className={FIELD_GRID}>
        <NumberField
          label={grouped ? 'Group priority' : 'Priority'}
          hint={grouped ? '0 is highest within this group' : undefined}
          name="priority"
          value={values.priority}
          min={grouped ? 0 : -1_000_000}
          max={grouped ? MAX_GROUP_PRIORITY : 1_000_000}
          placeholder="0"
          onChange={(value) => setValue('priority', value)}
        />
        <NumberField
          label={OPTION_LABELS.delay}
          hint="In milliseconds. 60000 is one minute."
          name="delay"
          value={values.delay}
          min={0}
          max={MAX_DELAY_MS}
          placeholder="0"
          disabled={values.runAt.trim() !== ''}
          onChange={(value) => setValue('delay', value)}
        />
        <Field
          label="Run at"
          hint={
            values.runAt.trim() ? 'Your local time. This replaces the wait.' : 'Your local time.'
          }
        >
          <Input
            type="datetime-local"
            name="run-at"
            value={values.runAt}
            onChange={(event) => setValue('runAt', event.target.value)}
          />
        </Field>
        <NumberField
          label={OPTION_LABELS.maxAttempts}
          name="max-attempts"
          value={values.maxAttempts}
          min={1}
          max={1000}
          placeholder="3"
          onChange={(value) => setValue('maxAttempts', value)}
        />
      </div>
      <Disclosure
        summary="More options"
        className="mt-4 border-t border-line pt-2"
        defaultOpen={moreOpen}
      >
        <div className={FIELD_GRID}>
          <NumberField
            label={OPTION_LABELS.backoff}
            hint="In milliseconds."
            name="backoff"
            value={values.backoff}
            min={0}
            max={MAX_DURATION_MS}
            placeholder="1000"
            onChange={(value) => setValue('backoff', value)}
          />
          <Field label={OPTION_LABELS.backoffType}>
            <Select
              name="backoff-strategy"
              value={values.backoffType}
              onChange={(event) =>
                setValue('backoffType', event.target.value as AddJobFormValues['backoffType'])
              }
            >
              <option value="">Default (flat)</option>
              <option value="fixed">Fixed</option>
              <option value="exponential">Exponential (grows each time)</option>
            </Select>
          </Field>
          <NumberField
            label={OPTION_LABELS.timeout}
            hint="In milliseconds. Empty is no limit."
            name="timeout"
            value={values.timeout}
            min={0}
            max={MAX_DURATION_MS}
            placeholder="—"
            onChange={(value) => setValue('timeout', value)}
          />
          <NumberField
            label={OPTION_LABELS.ttl}
            hint="In milliseconds. Empty is never."
            name="ttl"
            value={values.ttl}
            min={0}
            max={MAX_DELAY_MS}
            placeholder="—"
            onChange={(value) => setValue('ttl', value)}
          />
          <TextField
            label="Your own job ID"
            hint="Optional. Use it to avoid adding the same job twice."
            name="custom-job-id"
            value={values.jobId}
            placeholder="idempotency key"
            onChange={(value) => setValue('jobId', value)}
          />
        </div>
        <div className="mt-4 flex flex-col gap-1">
          <ToggleRow
            label="Delete it when it finishes"
            checked={values.removeOnComplete}
            onChange={(checked) => setValue('removeOnComplete', checked)}
          />
          <ToggleRow
            label="Delete it if it fails"
            checked={values.removeOnFail}
            onChange={(checked) => setValue('removeOnFail', checked)}
          />
          <ToggleRow
            label="Run the newest first"
            checked={values.lifo}
            onChange={(checked) => setValue('lifo', checked)}
          />
        </div>
        <div className="mt-2 border-t border-line pt-2">
          <AddJobAdvanced values={values} setValue={setValue} defaultOpen={advancedOpen} />
        </div>
      </Disclosure>
    </Card>
  );
}
