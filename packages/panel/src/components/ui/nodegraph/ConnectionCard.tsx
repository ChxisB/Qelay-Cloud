import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { ConnectionStatus, type ConnectionState } from './connectionState';
import { RuleGlyph, type RuleView } from './RuleGlyph';

/**
 * The body of the hover card: the state, the connection's name and route, then its rules in the order an event
 * meets them (each with its glyph, a sentence and On or Off), then the rules that are the same for every
 * connection. `actions` is where the caller puts Open and the menu.
 */
export function ConnectionCard({
  name,
  route,
  state,
  stateLabel,
  rules,
  fixed,
  actions,
}: {
  name: string;
  route: string;
  state: ConnectionState;
  stateLabel: string;
  rules: readonly RuleView[];
  /** The rules every connection has, as short phrases: "Retry, 8 attempts". */
  fixed: readonly { name: string; label: string }[];
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3.5">
      <div className="flex flex-wrap items-center justify-between gap-2.5">
        <ConnectionStatus state={state} label={stateLabel} />
        {actions && <span className="flex items-center gap-1">{actions}</span>}
      </div>
      <div>
        <p className="text-[17px] leading-tight font-extrabold tracking-tight text-fg">{name}</p>
        <p className="text-[12.5px] text-muted">{route}</p>
      </div>
      <div>
        <p className="text-[12.5px] font-bold text-muted">
          Rules, in the order an event meets them
        </p>
        <ul>
          {rules
            .filter((rule) => rule.editable)
            .map((rule) => (
              <li
                key={rule.name}
                className="grid grid-cols-[28px_minmax(0,1fr)_auto] items-start gap-x-2.5 border-t border-line py-2 first:border-t-0"
              >
                <RuleGlyph name={rule.name} tone={rule.on ? 'on' : 'off'} decorative />
                <div>
                  <b className="text-[13.5px] font-extrabold text-fg">{rule.name}</b>
                  <p className="text-[12.5px] leading-snug text-muted">{rule.summary}</p>
                </div>
                <span className={cn('text-xs font-bold', rule.on ? 'text-active' : 'text-muted')}>
                  {rule.on ? 'On' : 'Off'}
                </span>
              </li>
            ))}
        </ul>
      </div>
      <ul className="flex flex-wrap gap-x-3 gap-y-1.5 border-t border-line pt-2.5 text-[12.5px] text-muted">
        {fixed.map((rule) => (
          <li key={rule.name} className="inline-flex items-center gap-1.5">
            <RuleGlyph name={rule.name} tone="fixed" decorative small />
            {rule.label}
          </li>
        ))}
      </ul>
    </div>
  );
}
