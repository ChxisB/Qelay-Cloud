import { Field, Select } from '@/components/ui/form';
import type { DestinationFull } from '@/lib/bq';
import { addressOf } from './destinationFields';

/**
 * Chooses one of the saved destinations. The address is shown under the choice, so a person knows what
 * the new connection will send to; it is a copy, moved later by editing the destination.
 */
export function DestinationPicker({
  destinations,
  value,
  onChange,
}: {
  destinations: readonly DestinationFull[];
  value: string;
  onChange: (id: string) => void;
}) {
  const chosen = destinations.find((destination) => destination.id === value);
  return (
    <div>
      <Field
        label="Saved destination"
        hint="A name for an address. Editing the destination later moves every connection made from it."
      >
        <Select
          value={value}
          name="route-destination"
          onChange={(event) => onChange(event.currentTarget.value)}
        >
          <option value="">Choose a destination</option>
          {destinations.map((destination) => (
            <option key={destination.id} value={destination.id}>
              {destination.name}
            </option>
          ))}
        </Select>
      </Field>
      {chosen && (
        <p className="mt-2 break-all font-mono text-xs text-muted">
          {chosen.kind === 'queue' ? 'Queue ' : ''}
          {addressOf(chosen)}
        </p>
      )}
    </div>
  );
}
