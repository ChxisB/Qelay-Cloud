import type { ChangeEvent } from 'react';
import { Banner } from '@/components/ui/Banner';
import { buttonClass } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import { SegmentedControl, Textarea } from '@/components/ui/form';
import { BULK_SAMPLE, MAX_BULK_INPUT_CHARS, MAX_JOBS } from './constants';
import type { BulkFormValues, SetBulkFormValue } from './formTypes';

export function BulkJobsCard({
  values,
  setValue,
  parsedCount,
  parseError,
  validation,
  onFile,
  onBeforeTextChange,
}: {
  values: BulkFormValues;
  setValue: SetBulkFormValue;
  parsedCount: number;
  parseError: string | null;
  validation: { ok: boolean; msg?: string };
  onFile: (event: ChangeEvent<HTMLInputElement>) => void;
  onBeforeTextChange: () => void;
}) {
  return (
    <Card className="lg:col-span-2">
      <CardHeader
        title="Jobs"
        sub="Paste a JSON list, one JSON object, or one JSON object per line."
        action={
          // The input is visually hidden, not display:none, so the keyboard can reach it.
          <label
            className={buttonClass(
              'default',
              'sm',
              'cursor-pointer has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring'
            )}
          >
            Upload file
            <input
              type="file"
              name="jobs-file"
              accept=".json,.ndjson,.txt,application/json"
              onChange={onFile}
              className="sr-only"
            />
          </label>
        }
      />
      <Textarea
        name="jobs-json"
        value={values.text}
        onChange={(event) => {
          onBeforeTextChange();
          setValue('text', event.target.value);
        }}
        maxLength={MAX_BULK_INPUT_CHARS}
        spellCheck={false}
        rows={16}
        placeholder={BULK_SAMPLE}
        aria-label="Jobs JSON"
        aria-invalid={parseError || parsedCount > MAX_JOBS ? true : undefined}
        aria-describedby="jobs-json-status"
        className="font-mono text-[13px] leading-relaxed"
      />
      <fieldset className="mt-3 flex flex-wrap items-center gap-3">
        <legend className="sr-only">How to read each item</legend>
        <span aria-hidden="true" className="text-[13px] font-semibold text-muted">
          Each item is
        </span>
        <SegmentedControl
          options={['spec', 'raw'] as const}
          value={values.mode}
          onChange={(mode) => setValue('mode', mode)}
          label="How to read each item"
          format={(mode) => (mode === 'spec' ? 'A job with options' : 'Just the data')}
          asWritten
        />
        <span className="text-[13px] text-muted">
          {values.mode === 'spec'
            ? 'An object with a "data" key. Its other fields, such as priority, are the job\'s options.'
            : 'The whole item is sent to the worker as it is.'}
        </span>
      </fieldset>
      <div id="jobs-json-status" className="mt-3 text-[13px] font-semibold">
        {parseError ? (
          <span role="alert" className="text-danger">
            {parseError}
          </span>
        ) : parsedCount > MAX_JOBS ? (
          <span role="alert" className="text-danger">
            Too many jobs ({parsedCount}). Limit is {MAX_JOBS}.
          </span>
        ) : parsedCount > 0 ? (
          <span className="text-success">{parsedCount} job(s) parsed ✓</span>
        ) : (
          <span className="text-muted">Nothing parsed yet.</span>
        )}
      </div>
      {!parseError && parsedCount > 0 && !validation.ok && (
        <div className="mt-4">
          <Banner tone="problem" title="Import blocked">
            {validation.msg}. Fix the item, or switch to “Just the data” when the whole object is
            the job's data.
          </Banner>
        </div>
      )}
    </Card>
  );
}
