import {
  Field,
  FieldAction,
  FormRow,
  Input,
  SegmentedControl,
  Textarea,
} from '@/components/ui/form';
import { cn } from '@/lib/cn';
import { nextCronRuns } from '@/lib/cronPreview';
import { formatDateTime } from '@/lib/format';
import { MAX_JOB_DATA_CHARS } from '../AddJob';
import { CronWire } from './CronWire';
import { type CronFormValues, everyPreview, MAX_DELAY_MS, type SetCronFormValue } from './model';

export function CronPrimaryFields({
  values,
  setValue,
}: {
  values: CronFormValues;
  setValue: SetCronFormValue;
}) {
  const preview =
    values.mode === 'cron' && values.schedule.trim()
      ? nextCronRuns(values.schedule.trim(), 3, Date.now())
      : null;
  const intervalPreview = everyPreview(values.every);
  const cron = values.mode === 'cron';

  return (
    <>
      <div className="grid grid-cols-1 items-start gap-4 sm:grid-cols-3">
        <Field label="Name" hint="A unique name for this schedule.">
          <Input
            name="cron-name"
            autoComplete="off"
            maxLength={256}
            value={values.name}
            onChange={(event) => setValue('name', event.target.value)}
            placeholder="daily-report"
          />
        </Field>
        <Field label="Queue" hint="Where the jobs are added.">
          <Input
            name="cron-queue"
            autoComplete="off"
            maxLength={256}
            value={values.queue}
            onChange={(event) => setValue('queue', event.target.value)}
            placeholder="reports"
          />
        </Field>
        <Field
          label="Job name"
          hint="What workers see as each job's name. Leave as default if unsure."
        >
          <Input
            name="cron-job-name"
            autoComplete="off"
            maxLength={256}
            value={values.jobName}
            onChange={(event) => setValue('jobName', event.target.value)}
            placeholder="default"
          />
        </Field>
      </div>

      <FormRow>
        <FieldAction>
          <SegmentedControl
            options={['cron', 'every'] as const}
            value={values.mode}
            label="Schedule type"
            format={(mode) => (mode === 'cron' ? 'At set times' : 'Every so often')}
            asWritten
            onChange={(mode) => setValue('mode', mode)}
          />
        </FieldAction>
        {values.mode === 'cron' ? (
          <div className="min-w-56 flex-1">
            <Field
              label="Cron expression"
              hint="Five fields: minute, hour, day, month, weekday. 0 9 * * * is 09:00 every day. @hourly and @daily also work."
            >
              <Input
                name="cron-expression"
                value={values.schedule}
                onChange={(event) => setValue('schedule', event.target.value)}
                placeholder="0 9 * * *"
              />
            </Field>
          </div>
        ) : (
          <>
            <div className="w-48">
              <Field label="Every (ms)" hint="1000 is one second.">
                <Input
                  type="number"
                  min={1}
                  max={MAX_DELAY_MS}
                  step={1}
                  name="cron-interval"
                  value={values.every}
                  onChange={(event) => setValue('every', event.target.value)}
                  placeholder="30000"
                />
              </Field>
            </div>
            {values.every.trim() !== '' && (
              <FieldAction>
                <span className={cn('text-[13px]', intervalPreview ? 'text-muted' : 'text-danger')}>
                  {intervalPreview ?? 'not a valid interval'}
                </span>
              </FieldAction>
            )}
          </>
        )}
      </FormRow>

      {values.mode === 'cron' && values.schedule.trim() && preview && (
        <div className="rounded-control border border-line bg-slate-tint px-4 py-3 text-[13px]">
          {preview.valid ? (
            preview.runs.length ? (
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                {/* nextCronRuns evaluates in the browser's timezone, never the server's. */}
                <span className="text-faint">Next runs (browser-local time):</span>
                {preview.runs.map((run) => (
                  <span
                    key={run}
                    className="rounded-full border border-line bg-surface px-2.5 py-0.5 font-mono text-xs text-fg"
                  >
                    {formatDateTime(run)}
                  </span>
                ))}
                <span className="text-faint">
                  {values.timezone.trim()
                    ? `— server evaluates in ${values.timezone.trim()}`
                    : '— no timezone set: the server evaluates in its own timezone, which may differ'}
                </span>
              </div>
            ) : (
              <span className="text-warning">Valid, but no runs in the next few years.</span>
            )
          ) : (
            <span className="text-warning">
              That cron expression is not supported: {preview.error} Fix it before creating the
              schedule.
            </span>
          )}
        </div>
      )}

      <CronWire
        when={cron ? values.schedule.trim() : (intervalPreview ?? '')}
        valid={cron ? preview?.valid === true : intervalPreview !== null}
        queue={values.queue.trim()}
        job={(values.jobName ?? '').trim()}
      />

      <Field
        label="Data (JSON)"
        hint="Sent to the worker with every job. Leave {} if there is none."
      >
        <Textarea
          name="cron-data"
          value={values.dataText}
          onChange={(event) => setValue('dataText', event.target.value)}
          maxLength={MAX_JOB_DATA_CHARS}
          rows={3}
          spellCheck={false}
          className="font-mono text-sm"
        />
      </Field>
    </>
  );
}
