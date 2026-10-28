import { Field, Input, Textarea } from '@/components/ui/form';
import {
  DEDUPE_MAX_SECONDS,
  DELAY_MAX_SECONDS,
  DESCRIPTION_MAX,
  type EditField,
  type EditFields,
  NAME_MAX,
  type TextField,
} from './connectionPatch';
import { ConnectionSend } from './ConnectionSend';

const RULE_AREA = 'font-mono text-xs leading-5';

/**
 * Every field of a connection that can change after it is made: its name and the rules a request goes
 * through in order. The parent owns the values and the refusals; this only draws them.
 */
export function ConnectionFields({
  fields,
  onChange,
  errors,
  destination,
}: {
  fields: EditFields;
  onChange: <K extends EditField>(key: K, value: EditFields[K]) => void;
  errors: Partial<Record<EditField, string>>;
  /** Batches are for http destinations only; unset until one is chosen. */
  destination?: 'http' | 'queue';
}) {
  const text = (key: TextField) => ({
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
      <Field
        label="Filter"
        hint="A JSON object. Only requests that match are sent; empty sends every request of the source. Paths start with method, headers, query or body."
        error={errors.filter}
      >
        <Textarea
          value={fields.filter}
          onInput={(event) => onChange('filter', event.currentTarget.value)}
          rows={5}
          spellCheck={false}
          className={RULE_AREA}
          placeholder={'{ "headers.x-event": { "$startsWith": "invoice" } }'}
        />
      </Field>
      <Field
        label="Shape"
        hint='A JSON object that becomes the body. { "$": "body.id" } takes a field of the request; empty sends the request as it came.'
        error={errors.shape}
      >
        <Textarea
          value={fields.shape}
          onInput={(event) => onChange('shape', event.currentTarget.value)}
          rows={5}
          spellCheck={false}
          className={RULE_AREA}
          placeholder={'{ "text": "New order", "order": { "$": "body.id" } }'}
        />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Delay (seconds)"
          hint={`Each request waits this long before it is sent. 1 to ${DELAY_MAX_SECONDS.toLocaleString('en')}; empty is no delay.`}
          error={errors.delay}
        >
          <Input {...text('delay')} inputMode="decimal" autoComplete="off" placeholder="None" />
        </Field>
        <Field
          label="Deduplicate within (seconds)"
          hint={`A request that repeats the fields below inside this window is dropped; the first goes. 1 to ${DEDUPE_MAX_SECONDS.toLocaleString('en')}; empty is off.`}
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
        <Field
          label="Fields that must repeat"
          hint="Document paths separated by commas. Two requests are the same when all of these are equal."
          error={errors.dedupeFields}
        >
          <Input
            {...text('dedupeFields')}
            autoComplete="off"
            placeholder="body.id, headers.x-event"
          />
        </Field>
      )}
      <ConnectionSend
        fields={fields}
        onChange={onChange}
        errors={errors}
        {...(destination && { destination })}
      />
    </div>
  );
}
