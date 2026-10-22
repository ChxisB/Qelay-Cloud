import { ConnectionLine } from '@/components/ui/nodegraph/ConnectionLine';
import { ConnectionNode, type NodeKind } from '@/components/ui/nodegraph/ConnectionNode';
import { type ConnectionState, WIRE_COLOUR } from '@/components/ui/nodegraph/connectionState';
import { RuleGlyph } from '@/components/ui/nodegraph/RuleGlyph';
import { cn } from '@/lib/cn';
import { FIXED_LABELS } from './connectionRules';

/** One end of the chain. `missing` is an end not chosen yet: drawn dashed, and `name` says what is missing. */
export interface ChainEnd {
  kind: NodeKind;
  icon: string;
  name: string;
  sub?: string;
  missing?: boolean;
}

/** A rule set on the connection, with the word that says how it stands. */
export interface ChainStation {
  name: string;
  word: string;
}

// The wide layout is a row from `lg`; the narrow one (and the form's side panel, always) stacks under a spine.
const LAYOUT = {
  wide: {
    root: 'lg:grid lg:grid-cols-[14rem_minmax(0,1fr)_14rem] lg:items-center',
    spine: 'lg:hidden',
    line: 'justify-start max-lg:[&>span]:hidden lg:justify-center',
    list: 'flex-col items-start gap-2 pl-4 lg:flex-row lg:items-center lg:gap-3 lg:pl-0',
    station: 'lg:block',
    label:
      'lg:absolute lg:top-[calc(100%+4px)] lg:left-1/2 lg:w-[88px] lg:-translate-x-1/2 lg:text-center',
    words: 'lg:flex-col lg:gap-0',
    room: 'lg:pb-6',
  },
  stacked: {
    root: '',
    spine: '',
    line: 'justify-start [&>span]:hidden',
    list: 'flex-col items-start gap-2 pl-4',
    station: '',
    label: '',
    words: '',
    room: '',
  },
};

/**
 * What a connection does with an event, drawn as a line: the source, a glyph and a word for each rule set on the
 * connection in the order an event meets them, the destination, and a last line for the rules that are always on.
 * It holds no action. `state` gives the line its pattern and colour; `pulse` is a count that moves only when events
 * really arrived (each move sends one comet). The Overview draws a saved connection with it and the new-connection
 * form draws the typed one (`stacked`, always under a spine).
 */
export function ConnectionChain({
  source,
  destination,
  stations,
  state,
  pulse = 0,
  stacked = false,
}: {
  source: ChainEnd;
  destination: ChainEnd;
  stations: readonly ChainStation[];
  state: ConnectionState;
  pulse?: number;
  stacked?: boolean;
}) {
  const layout = stacked ? LAYOUT.stacked : LAYOUT.wide;
  const end = (side: ChainEnd, endState: ConnectionState) => (
    <ConnectionNode
      kind={side.kind}
      icon={side.icon}
      name={side.name}
      sub={side.sub}
      state={endState}
      placeholder={side.missing}
    />
  );
  return (
    <div>
      <div
        className={cn(
          'relative flex flex-col gap-4',
          layout.root,
          stations.length > 0 && layout.room
        )}
      >
        <span
          aria-hidden="true"
          className={cn(
            'absolute top-15 bottom-15 left-[29px] w-0.5 bg-current',
            layout.spine,
            WIRE_COLOUR[state]
          )}
        />
        {end(source, 'active')}
        <ConnectionLine state={state} pulse={pulse} className={layout.line}>
          {stations.length > 0 && (
            <ol
              aria-label="Rules, in the order an event meets them"
              className={cn('m-0 flex list-none p-0', layout.list)}
            >
              {stations.map((station) => (
                <li
                  key={station.name}
                  className={cn('relative flex items-center gap-2', layout.station)}
                >
                  <RuleGlyph name={station.name} tone="on" decorative />
                  <span className={cn('flex items-baseline gap-1.5', layout.words, layout.label)}>
                    <b className="text-xs font-bold text-fg">{station.name}</b>
                    <span className="text-xs text-muted">{station.word}</span>
                  </span>
                </li>
              ))}
            </ol>
          )}
        </ConnectionLine>
        {end(destination, state)}
      </div>
      <ul className="m-0 mt-4 flex list-none flex-wrap items-center gap-x-3 gap-y-1.5 p-0 text-[12.5px] text-muted">
        <li className="font-semibold text-fg">
          {stations.length > 0 ? 'Always on, after these:' : 'No rules set. Always on:'}
        </li>
        {Object.entries(FIXED_LABELS).map(([name, label]) => (
          <li key={name} className="inline-flex items-center gap-1.5">
            <RuleGlyph name={name} tone="fixed" decorative small />
            {label}
          </li>
        ))}
      </ul>
    </div>
  );
}
