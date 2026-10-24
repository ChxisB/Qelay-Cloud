import { useMemo } from 'react';
import { Field, Input, Select, Toggle } from '@/components/ui/form';
import type { EditField, EditFields } from './connectionPatch';
import {
  BATCH_EVENTS_DEFAULT,
  BATCH_EVENTS_MAX,
  BATCH_KIB_DEFAULT,
  BATCH_KIB_MAX,
  CRON_MAX,
  SEND_CUSTOM,
  SEND_NOW,
  SEND_PRESETS,
  zoneNames,
} from './sendRules';

/**
 * When a connection's events go out and whether they go one by one: a schedule (a cron in a time zone) and, for an
 * http destination, batches. The parent owns the values and the refusals; this only draws them.
 */
export function ConnectionSend({
  fields,
  onChange,
  errors,
  destination = 'http',
}: {
  fields: EditFields;
  onChange: <K extends EditField>(key: K, value: EditFields[K]) => void;
  errors: Partial<Record<EditField, string>>;
  destination?: 'http' | 'queue';
}) {
  const zones = useMemo(() => zoneNames(fields.sendZone), [fields.sendZone]);
  const scheduled = fields.sendMode !== SEND_NOW;
  const custom = fields.sendMode === SEND_CUSTOM;
  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Send"
          hint="Hold events and send them at a set time, like every night. They wait their delay first."
          error={errors.sendMode ?? (custom ? undefined : errors.sendCron)}
        >
          <Select
            name="sendMode"
            value={fields.sendMode}
            onChange={(event) => onChange('sendMode', event.currentTarget.value)}
          >
            <option value={SEND_NOW}>As soon as they arrive</option>
            {SEND_PRESETS.map((preset) => (
              <option key={preset.cron} value={preset.cron}>
                {preset.label}
              </option>
            ))}
            <option value={SEND_CUSTOM}>On a cron schedule…</option>
          </Select>
        </Field>
        {scheduled && (
          <Field
            label="Time zone"
            hint="The schedule is read in this zone, so midnight follows its clock changes."
            error={errors.sendZone}
          >
            <Select
              name="sendZone"
              value={fields.sendZone}
              onChange={(event) => onChange('sendZone', event.currentTarget.value)}
            >
              {zones.map((zone) => (
                <option key={zone} value={zone}>
                  {zone}
                </option>
              ))}
            </Select>
          </Field>
        )}
      </div>
      {custom && (
        <Field
          label="Cron"
          hint="Five fields: minute, hour, day of month, month, weekday. 30 6 * * 1-5 is 06:30 on weekdays. It must fire at least once a month."
          error={errors.sendCron}
        >
          <Input
            name="sendCron"
            value={fields.sendCron}
            onInput={(event) => onChange('sendCron', event.currentTarget.value)}
            maxLength={CRON_MAX}
            autoComplete="off"
            spellCheck={false}
            className="font-mono text-xs"
            placeholder="0 0 * * *"
          />
        </Field>
      )}
      {destination === 'http' && (
        <div className="flex flex-col gap-3">
          <div className="flex items-start gap-3">
            <Toggle
              checked={fields.batchOn}
              onChange={(on) => onChange('batchOn', on)}
              label="Send in batches"
            />
            <div className="flex flex-col gap-1">
              <span className="text-[13px] font-bold leading-6 text-fg">Send in batches</span>
              <p className="text-[12px] leading-relaxed text-faint">
                Events that are due together go out as one signed request,{' '}
                <code className="font-mono">{'{ batchId, count, events }'}</code>, and are retried
                together. The receiver must read that shape.
              </p>
            </div>
          </div>
          {fields.batchOn && (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label="Events per request"
                hint={`1 to ${BATCH_EVENTS_MAX}. Empty is ${BATCH_EVENTS_DEFAULT}.`}
                error={errors.batchEvents}
              >
                <Input
                  name="batchEvents"
                  value={fields.batchEvents}
                  onInput={(event) => onChange('batchEvents', event.currentTarget.value)}
                  inputMode="numeric"
                  autoComplete="off"
                  placeholder={String(BATCH_EVENTS_DEFAULT)}
                />
              </Field>
              <Field
                label="Most data per request (KiB)"
                hint={`1 to ${BATCH_KIB_MAX.toLocaleString('en')}. A request stops filling before it passes this. Empty is ${BATCH_KIB_DEFAULT}.`}
                error={errors.batchKib}
              >
                <Input
                  name="batchKib"
                  value={fields.batchKib}
                  onInput={(event) => onChange('batchKib', event.currentTarget.value)}
                  inputMode="decimal"
                  autoComplete="off"
                  placeholder={String(BATCH_KIB_DEFAULT)}
                />
              </Field>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
