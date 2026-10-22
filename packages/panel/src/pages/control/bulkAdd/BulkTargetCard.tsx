import { Banner } from '@/components/ui/Banner';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import { Field, Input } from '@/components/ui/form';
import { NumberField } from '../addJob/AddJobFields';
import { OPTION_LABELS } from '../addJob/options';
import { MAX_DURATION_MS, MAX_JOBS } from './constants';
import type { BulkFormValues, BulkResult, SetBulkFormValue } from './formTypes';

export function BulkTargetCard({
  values,
  setValue,
  queueNames,
  queueDiscoveryError,
  onRetryQueues,
  busy,
  parsedCount,
  parseError,
  validationOk,
  result,
  onSubmit,
}: {
  values: BulkFormValues;
  setValue: SetBulkFormValue;
  queueNames: string[];
  queueDiscoveryError: Error | null;
  onRetryQueues: () => void;
  busy: boolean;
  parsedCount: number;
  parseError: string | null;
  validationOk: boolean;
  result: BulkResult;
  onSubmit: () => void;
}) {
  return (
    <Card>
      <CardHeader title="Send to" sub="Pick the queue the jobs go into." />
      <div className="flex flex-col gap-4">
        <Field label="Queue">
          <Input
            list="bulk-queue-options"
            aria-label="Queue"
            name="bulk-target-queue"
            autoComplete="off"
            value={values.queue}
            onChange={(event) => setValue('queue', event.target.value)}
            placeholder="queue name (existing or new)"
          />
          <datalist id="bulk-queue-options">
            {queueNames.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
        </Field>
        {queueDiscoveryError && (
          <p role="status" className="-mt-2 text-[13px] font-semibold text-warning">
            Existing queue suggestions unavailable — {queueDiscoveryError.message}. You can still
            enter a queue name manually.{' '}
            <button
              type="button"
              onClick={onRetryQueues}
              className="font-bold underline underline-offset-2 hover:text-fg"
            >
              Retry
            </button>
          </p>
        )}
        <div className="border-t border-line pt-4">
          <h3 className="text-[13px] font-bold text-fg">Defaults for every job</h3>
          <p className="mt-1 text-[13px] text-muted">Used when a job does not set its own.</p>
        </div>
        <div className="grid grid-cols-[repeat(auto-fit,minmax(9rem,1fr))] gap-4">
          <NumberField
            label="Priority"
            name="default-priority"
            value={values.priority}
            min={-1_000_000}
            max={1_000_000}
            placeholder="0"
            onChange={(value) => setValue('priority', value)}
          />
          <NumberField
            label={OPTION_LABELS.maxAttempts}
            name="default-max-attempts"
            value={values.maxAttempts}
            min={1}
            max={1000}
            placeholder="3"
            onChange={(value) => setValue('maxAttempts', value)}
          />
          <NumberField
            label={OPTION_LABELS.backoff}
            hint="In milliseconds."
            name="default-backoff"
            value={values.backoff}
            min={0}
            max={MAX_DURATION_MS}
            placeholder="1000"
            onChange={(value) => setValue('backoff', value)}
          />
          <NumberField
            label={OPTION_LABELS.timeout}
            hint="In milliseconds."
            name="default-timeout"
            value={values.timeout}
            min={0}
            max={MAX_DURATION_MS}
            placeholder="—"
            onChange={(value) => setValue('timeout', value)}
          />
        </div>
        <div className="flex items-center gap-3">
          <Button
            variant="primary"
            disabled={
              busy ||
              parsedCount === 0 ||
              parsedCount > MAX_JOBS ||
              parseError != null ||
              !validationOk
            }
            onClick={onSubmit}
          >
            {busy ? 'Importing…' : `Import ${parsedCount || ''}`}
          </Button>
        </div>
        {result && (
          <Banner
            tone={result.ok ? 'ok' : 'problem'}
            title={result.ok ? 'Import accepted' : 'The import did not go through'}
          >
            {result.msg}
          </Banner>
        )}
      </div>
    </Card>
  );
}
