import type { ReactNode } from 'react';

/** A setting this server fixes, shown as a plain "name: value" list instead of a field that looks editable. */
export function Facts({ items }: { items: ReadonlyArray<{ label: string; value: ReactNode }> }) {
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-[13px] sm:grid-cols-[minmax(0,14rem)_1fr]">
      {items.map(({ label, value }) => (
        <div key={label} className="contents">
          <dt className="text-muted">{label}</dt>
          <dd className="font-bold text-fg">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
