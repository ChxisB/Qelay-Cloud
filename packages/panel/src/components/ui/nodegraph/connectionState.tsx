import { cn } from '@/lib/cn';

/** How a connection stands: sending, held by a person, stopped by repeated failures, or switched off. */
export type ConnectionState = 'active' | 'held' | 'paused' | 'off';

/** The line's pattern is the state's second cue after the colour: solid, dashed or dotted. */
export type WireStyle = 'solid' | 'dashed' | 'dotted';

const STATE: Record<
  ConnectionState,
  { wire: WireStyle; colour: string; half: string; mark: string }
> = {
  active: { wire: 'solid', colour: 'text-active', half: 'M9 1.4a7.6 7.6 0 0 1 0 15.2z', mark: '' },
  held: { wire: 'dashed', colour: 'text-warn', half: '', mark: 'M7.2 6v6M10.8 6v6' },
  paused: {
    wire: 'dashed',
    colour: 'text-bad',
    half: '',
    mark: 'M6.2 6.2l5.6 5.6M11.8 6.2l-5.6 5.6',
  },
  off: { wire: 'dotted', colour: 'text-faint', half: '', mark: 'M5.8 9h6.4' },
};

export const wireStyle = (state: ConnectionState): WireStyle => STATE[state].wire;

/** Text colour of a line: a solid one is neutral, the others take their state's colour. */
export const WIRE_COLOUR: Record<ConnectionState, string> = {
  active: 'text-line-strong',
  held: 'text-warn',
  paused: 'text-bad',
  off: 'text-faint',
};

/** Decorative: always sits beside the state's word, which carries the meaning. */
export function ConnectionGlyph({
  state,
  className,
}: {
  state: ConnectionState;
  className?: string;
}) {
  const { colour, half, mark } = STATE[state];
  return (
    <svg
      viewBox="0 0 18 18"
      aria-hidden="true"
      focusable="false"
      className={cn('size-4 shrink-0', colour, className)}
    >
      <circle cx="9" cy="9" r="8" fill="none" stroke="currentColor" strokeWidth="1.7" />
      {half && <path d={half} fill="currentColor" />}
      {mark && (
        <path
          d={mark}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
    </svg>
  );
}

/** The state as glyph and word. `label` is the panel's wording, so the part holds no copy of its own. */
export function ConnectionStatus({ state, label }: { state: ConnectionState; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-bold text-fg">
      <ConnectionGlyph state={state} />
      {label}
    </span>
  );
}
