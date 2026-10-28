import { Field, Select } from '@/components/ui/form';
import type { SourceFull } from '@/lib/bq';

/**
 * Chooses the inbound source a connection reads. Every connection has one: the names are what a person knows
 * them by, the id is what is sent. A source that is off can still be chosen, and says so.
 */
export function SourcePicker({
  sources,
  value,
  onChange,
}: {
  sources: readonly SourceFull[];
  value: string;
  onChange: (id: string) => void;
}) {
  return (
    <Field
      label="Source"
      hint={
        sources.length === 0
          ? 'There is no source yet. Add one on the Sources tab, then come back.'
          : 'Where the requests come from. A request sent to this source is sent on by this connection.'
      }
    >
      <Select
        value={value}
        name="webhook-source"
        onChange={(event) => onChange(event.currentTarget.value)}
      >
        <option value="">Choose a source</option>
        {sources.map((source) => (
          <option key={source.id} value={source.id}>
            {source.enabled ? source.name : `${source.name} (off)`}
          </option>
        ))}
      </Select>
    </Field>
  );
}
