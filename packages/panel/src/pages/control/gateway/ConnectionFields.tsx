import type { ReactNode } from 'react';
import { Button } from '@/components/ui/Button';
import { Field, Input, Textarea } from '@/components/ui/form';
import { WEBHOOK_DEDUPE_FIELDS, WEBHOOK_EVENTS } from '@/lib/bq';
import {
  DEDUPE_MAX_SECONDS,
  DELAY_MAX_SECONDS,
  DESCRIPTION_MAX,
  type EditField,
  type EditFields,
  NAME_MAX,
} from './connectionPatch';

/** A list of choices as pressed buttons, as the new connection form does for events. */
function Choices({
  label,
  hint,
  options,
  chosen,
  onChange,
  error,
}: {
  label: string;
  hint: string;
  options: readonly string[];
  chosen: readonly string[];
  onChange: (next: string[]) => void;
  error?: ReactNode;
}) {
  const id = `choices-${label.replace(/\W+/g, '-').toLowerCase()}`;
  return (
    <div role="group" aria-labelledby={id}>
      <p id={id} className="mb-1 text-[13px] font-bold leading-5 text-fg">
        {label}
      </p>
      <p className="mb-2 text-[13px] text-muted">{hint}</p>
      <div className="flex flex-wrap gap-2">
        {options.map((option) => (
          <Button
            key={option}
            size="sm"
            variant={chosen.includes(option) ? 'primary' : 'default'}
            aria-pressed={chosen.includes(option)}
            onClick={() =>
              onChange(
                chosen.includes(option)
                  ? chosen.filter((item) => item !== option)
                  : [...chosen, option]
              )
            }
          >
            {option}
          </Button>
        ))}
      </div>
      {error && (
        <p role="alert" className="mt-2 text-[12px] font-semibold text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

const RULE_AREA = 'font-mono text-xs leading-5';

/**
 * Every field of a connection that can change after it is made: its name, the events it hears, and the rules
 * an event goes through in order. The parent owns the values and the refusals; this only draws them.
 */
export function ConnectionFields({
  fields,
  onChange,
  errors,
}: {
  fields: EditFields;
  onChange: <K extends EditField>(key: K, value: EditFields[K]) => void;
  errors: Partial<Record<EditField, string>>;
}) {
  const text = (key: 'name' | 'description' | 'delay' | 'dedupeWindow') => ({
    value: fields[key],
    onInput: (event: { currentTarget: { value: string } }) =>
      onChange(key, event.currentTarget.value),
  });
  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name" hint="Shown instead of the address. Optional." error={errors.name}>
          <Input {...text('name')} maxLength={NAME_MAX} autoComplete="off" placeholder="Billing" />
        </Field>
        <Field
          label="Description"
          hint="A note for whoever finds it later."
          error={errors.description}
        >
          <Textarea
            {...text('description')}
            rows={2}
            maxLength={DESCRIPTION_MAX}
            placeholder="Sends failed payments to the billing team"
          />
        </Field>
      </div>
      <Choices
        label="Events to send"
        hint="Pressed buttons are sent."
        options={WEBHOOK_EVENTS}
        chosen={fields.events}
        onChange={(next) => onChange('events', next)}
        error={errors.events}
      />
      <Field
        label="Filter"
        hint="A JSON object. Only events that match are sent; empty sends every event of the source. Fields: event, queue, jobId, state, error, progress, occurredAt."
        error={errors.filter}
      >
        <Textarea
          value={fields.filter}
          onInput={(event) => onChange('filter', event.currentTarget.value)}
          rows={5}
          spellCheck={false}
          className={RULE_AREA}
          placeholder={'{ "queue": { "$startsWith": "bill" } }'}
        />
      </Field>
      <Field
        label="Shape"
        hint='A JSON object that becomes the body. { "$": "jobId" } takes a field of the event; empty sends the standard body.'
        error={errors.shape}
      >
        <Textarea
          value={fields.shape}
          onInput={(event) => onChange('shape', event.currentTarget.value)}
          rows={5}
          spellCheck={false}
          className={RULE_AREA}
          placeholder={'{ "text": "Job failed", "job": { "$": "jobId" } }'}
        />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Delay (seconds)"
          hint={`Each event waits this long before it is sent. 1 to ${DELAY_MAX_SECONDS.toLocaleString('en')}; empty is no delay.`}
          error={errors.delay}
        >
          <Input {...text('delay')} inputMode="decimal" autoComplete="off" placeholder="None" />
        </Field>
        <Field
          label="Deduplicate within (seconds)"
          hint={`An event that repeats the fields below inside this window is dropped; the first goes. 1 to ${DEDUPE_MAX_SECONDS.toLocaleString('en')}; empty is off.`}
          error={errors.dedupeWindow}
        >
          <Input
            {...text('dedupeWindow')}
            inputMode="decimal"
            autoComplete="off"
            placeholder="Off"
          />
        </Field>
      </div>
      {fields.dedupeWindow.trim() !== '' && (
        <Choices
          label="Fields that must repeat"
          hint="Two events are the same when all of these are equal."
          options={WEBHOOK_DEDUPE_FIELDS}
          chosen={fields.dedupeFields}
          onChange={(next) => onChange('dedupeFields', next)}
          error={errors.dedupeFields}
        />
      )}
    </div>
  );
}
