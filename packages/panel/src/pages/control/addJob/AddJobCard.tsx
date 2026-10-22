import { Card, CardHeader } from '@/components/ui/Card';
import { Field, Input, Textarea } from '@/components/ui/form';
import { MAX_JOB_DATA_CHARS, parseJobData } from './data';
import type { AddJobFormValues, SetAddJobValue } from './formModel';

export function AddJobCard({
  values,
  setValue,
  queueNames,
  queueDiscoveryError,
  onRetryQueues,
  jsonError,
  setJsonError,
}: {
  values: AddJobFormValues;
  setValue: SetAddJobValue;
  queueNames: string[];
  queueDiscoveryError: Error | null;
  onRetryQueues: () => void;
  jsonError: string | null;
  setJsonError: (error: string | null) => void;
}) {
  return (
    <Card>
      <CardHeader title="Job" sub="Which queue gets the job, and the data it carries." />
      <div className="flex flex-col gap-4">
        <Field label="Queue">
          <Input
            list="queue-options"
            aria-label="Queue"
            name="target-queue"
            autoComplete="off"
            value={values.queue}
            onChange={(event) => setValue('queue', event.target.value)}
            placeholder="queue name (existing or new)"
          />
          <datalist id="queue-options">
            {queueNames.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
        </Field>
        <Field
          label="Job name"
          hint="Workers can pick jobs by this name. It is not part of the data."
        >
          <Input
            name="job-name"
            autoComplete="off"
            maxLength={256}
            value={values.name}
            onChange={(event) => setValue('name', event.target.value)}
            placeholder="default"
          />
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
        <Field
          label="Data (JSON)"
          hint="The information the worker receives, written as JSON."
          htmlFor="job-data"
        >
          <Textarea
            id="job-data"
            name="job-data"
            value={values.dataText}
            onChange={(event) => setValue('dataText', event.target.value)}
            onBlur={() => {
              const parsed = parseJobData(values.dataText);
              setJsonError(parsed.ok ? null : parsed.msg);
            }}
            maxLength={MAX_JOB_DATA_CHARS}
            spellCheck={false}
            rows={9}
            aria-invalid={jsonError ? true : undefined}
            aria-describedby={jsonError ? 'job-data-error' : undefined}
            className="font-mono text-[13px] leading-relaxed"
          />
          {jsonError && (
            <p id="job-data-error" role="alert" className="text-[12px] font-semibold text-danger">
              {jsonError}
            </p>
          )}
        </Field>
      </div>
    </Card>
  );
}
