import { Disclosure } from '@/components/ui/Disclosure';
import { Field, Textarea } from '@/components/ui/form';
import { NumberField, TextField } from './AddJobFields';
import type { AddJobFormValues, SetAddJobValue } from './formModel';
import { OPTION_LABELS } from './options';

/** Groups, tags, duplicate guard, dependencies and repeats: rarely needed, so one line until opened. */
export function AddJobAdvanced({
  values,
  setValue,
  defaultOpen,
}: {
  values: AddJobFormValues;
  setValue: SetAddJobValue;
  defaultOpen: boolean;
}) {
  return (
    <Disclosure summary="Advanced: groups, tags, repeats" defaultOpen={defaultOpen}>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(11rem,1fr))] gap-4">
        <TextField
          label="Tags"
          hint="Labels, separated by commas."
          name="tags"
          value={values.tags}
          placeholder="email, urgent"
          onChange={(value) => setValue('tags', value)}
        />
        <TextField
          label="Group ID"
          hint="The name of a group to put this job in."
          name="group-id"
          value={values.groupId}
          placeholder="—"
          onChange={(value) => setValue('groupId', value)}
        />
        <NumberField
          label={OPTION_LABELS.groupMaxSize}
          hint="Most jobs that may wait in the group. Needs a Group ID."
          name="group-max-size"
          value={values.groupMaxSize}
          min={1}
          max={Number.MAX_SAFE_INTEGER}
          placeholder="—"
          onChange={(value) => setValue('groupMaxSize', value)}
        />
        <TextField
          label="Unique key"
          hint="A job with the same key counts as the same job."
          name="unique-key"
          value={values.uniqueKey}
          placeholder="—"
          onChange={(value) => setValue('uniqueKey', value)}
        />
        <TextField
          label="Depends on"
          hint="Job IDs, separated by commas. This job waits for them."
          name="depends-on"
          value={values.dependsOn}
          placeholder="job-id-1, job-id-2"
          onChange={(value) => setValue('dependsOn', value)}
        />
        <div className="col-span-full">
          <Field
            label="Repeat"
            hint='For example {"every":60000,"limit":10} runs it every minute, 10 times. For cron patterns use Cron jobs.'
          >
            <Textarea
              name="repeat-policy"
              value={values.repeatText}
              onChange={(event) => setValue('repeatText', event.target.value)}
              rows={2}
              spellCheck={false}
              placeholder='{"every": 60000}'
              className="font-mono text-[13px]"
            />
          </Field>
        </div>
      </div>
    </Disclosure>
  );
}
