import { Select, SegmentedControl } from '@/components/ui/form';
import { SearchField } from '@/components/ui/SearchField';
import { STATE_FILTERS } from './model';

export const VIEWS = ['Structured', 'Table'] as const;
export type View = (typeof VIEWS)[number];

/** The Connections screen's controls: how to show the list, and which connections to show. */
export function ConnectionsToolbar({
  view,
  text,
  state,
  onChange,
}: {
  view: View;
  text: string;
  state: string;
  onChange: (key: 'view' | 'q' | 'state', value: string) => void;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-center gap-3">
      <SegmentedControl
        options={VIEWS}
        value={view}
        onChange={(next) => onChange('view', next)}
        label="How to show connections"
        asWritten
      />
      <SearchField
        aria-label="Search connections"
        containerClassName="w-full sm:w-72"
        value={text}
        onInput={(event) => onChange('q', event.currentTarget.value)}
        maxLength={100}
        placeholder="Filter by id, queue or address"
      />
      <Select
        aria-label="State"
        className="w-auto!"
        value={state}
        onChange={(event) => onChange('state', event.target.value)}
      >
        {STATE_FILTERS.map((item) => (
          <option key={item.value} value={item.value}>
            {item.label}
          </option>
        ))}
      </Select>
    </div>
  );
}
