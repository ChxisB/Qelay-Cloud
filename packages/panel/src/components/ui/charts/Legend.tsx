import { FILL, type Tone } from './tones';

/** Colour key. The label is the text; the swatch only repeats it. */
export function Legend({ items }: { items: Array<{ tone: Tone; label: string; value?: string }> }) {
  return (
    <ul className="flex flex-wrap gap-x-5 gap-y-2">
      {items.map((item) => (
        <li
          key={item.label}
          className="inline-flex items-center gap-2 text-[13px] font-semibold text-muted"
        >
          <span aria-hidden="true" className={`size-2.5 rounded-[3px] ${FILL[item.tone]}`} />
          {item.label}
          {item.value && <b className="font-bold text-fg">{item.value}</b>}
        </li>
      ))}
    </ul>
  );
}
