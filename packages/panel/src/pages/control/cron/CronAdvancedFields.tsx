import { NumberField, TextField, ToggleRow } from '../addJob/AddJobFields';
import { type CronFormValues, MAX_DELAY_MS, MAX_DURATION_MS, type SetCronFormValue } from './model';

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-t border-line pt-5">
      <h3 className="mb-4 text-[13px] font-bold text-fg">{title}</h3>
      {children}
    </section>
  );
}

const GRID = 'grid grid-cols-1 items-start gap-4 sm:grid-cols-2 lg:grid-cols-3';

export function CronAdvancedFields({
  values,
  setValue,
}: {
  values: CronFormValues;
  setValue: SetCronFormValue;
}) {
  return (
    <div className="flex flex-col gap-5">
      <div className={GRID}>
        <TextField
          label="Timezone"
          hint="For example Europe/London. Blank uses the server's timezone."
          name="cron-timezone"
          value={values.timezone}
          placeholder="Europe/London"
          onChange={(value) => setValue('timezone', value)}
        />
        <NumberField
          label="Priority"
          hint="Leave blank for the default."
          name="cron-priority"
          value={values.priority}
          min={-1_000_000}
          max={1_000_000}
          placeholder="0"
          onChange={(value) => setValue('priority', value)}
        />
        <NumberField
          label="Stop after this many runs"
          hint="Leave blank to keep going."
          name="cron-max-executions"
          value={values.maxLimit}
          min={1}
          max={Number.MAX_SAFE_INTEGER}
          placeholder="No limit"
          onChange={(value) => setValue('maxLimit', value)}
        />
      </div>
      <div className="flex flex-col gap-3">
        <ToggleRow
          label="Skip a run if the last one is still going"
          checked={values.preventOverlap}
          onChange={(checked) => setValue('preventOverlap', checked)}
        />
        <ToggleRow
          label="Skip a run if no worker is available"
          checked={values.skipIfNoWorker}
          onChange={(checked) => setValue('skipIfNoWorker', checked)}
        />
        <ToggleRow
          label="Run once straight away"
          checked={values.immediately}
          onChange={(checked) => setValue('immediately', checked)}
        />
        <ToggleRow
          label="Skip runs missed while the server was down"
          checked={values.skipMissedOnRestart}
          onChange={(checked) => setValue('skipMissedOnRestart', checked)}
        />
      </div>

      <Group title="Avoid duplicate runs">
        <div className={GRID}>
          <TextField
            label="Duplicate key"
            hint="Runs with the same key count as duplicates. Optional."
            name="cron-unique-key"
            value={values.uniqueKey}
            placeholder="daily-report"
            onChange={(value) => setValue('uniqueKey', value)}
          />
          <NumberField
            label="Remember the key for (ms)"
            hint="60000 is one minute. Blank remembers it until the job is gone."
            name="cron-dedup-ttl"
            value={values.dedupTtl}
            min={1}
            max={MAX_DELAY_MS}
            placeholder="60000"
            onChange={(value) => setValue('dedupTtl', value)}
          />
        </div>
        <div className="mt-4 flex flex-col gap-3">
          <ToggleRow
            label="Start the wait again when a duplicate arrives"
            checked={values.dedupExtend}
            onChange={(checked) => setValue('dedupExtend', checked)}
          />
          <ToggleRow
            label="Replace the waiting job with the new one"
            checked={values.dedupReplace}
            onChange={(checked) => setValue('dedupReplace', checked)}
          />
        </div>
      </Group>

      <Group title="Settings for each job it creates">
        <div className={GRID}>
          <NumberField
            label="Tries"
            hint="How many times a job may run if it fails."
            name="cron-job-max-attempts"
            value={values.jobMaxAttempts}
            min={1}
            max={1000}
            placeholder="3"
            onChange={(value) => setValue('jobMaxAttempts', value)}
          />
          <NumberField
            label="Wait between tries (ms)"
            hint="1000 is one second."
            name="cron-job-backoff"
            value={values.jobBackoff}
            min={0}
            max={MAX_DURATION_MS}
            placeholder="1000"
            onChange={(value) => setValue('jobBackoff', value)}
          />
          <NumberField
            label="Give up after (ms)"
            hint="Longest a job may run. Blank means no limit."
            name="cron-job-timeout"
            value={values.jobTimeout}
            min={0}
            max={MAX_DURATION_MS}
            placeholder="No limit"
            onChange={(value) => setValue('jobTimeout', value)}
          />
          <NumberField
            label="Start after a delay (ms)"
            hint="0 starts as soon as a worker is free."
            name="cron-job-delay"
            value={values.jobDelay}
            min={0}
            max={MAX_DELAY_MS}
            placeholder="0"
            onChange={(value) => setValue('jobDelay', value)}
          />
          <NumberField
            label="Treat as stuck after (ms)"
            hint="Blank uses the server's default."
            name="cron-job-stall-timeout"
            value={values.jobStallTimeout}
            min={0}
            max={MAX_DURATION_MS}
            placeholder="Server default"
            onChange={(value) => setValue('jobStallTimeout', value)}
          />
        </div>
        <div className="mt-4 flex flex-col gap-3">
          <ToggleRow
            label="Delete each job when it finishes"
            checked={values.jobRemoveOnComplete}
            onChange={(checked) => setValue('jobRemoveOnComplete', checked)}
          />
          <ToggleRow
            label="Delete each job when it fails"
            checked={values.jobRemoveOnFail}
            onChange={(checked) => setValue('jobRemoveOnFail', checked)}
          />
        </div>
      </Group>
    </div>
  );
}
