import { useState } from 'react';
import { ICON } from '@/components/layout/NavIcon';
import { ActionMenu } from '@/components/ui/ActionMenu';
import { Toggle } from '@/components/ui/form';
import { LinkButton } from '@/components/ui/LinkButton';
import { ConnectionCard } from '@/components/ui/nodegraph/ConnectionCard';
import { ConnectionLine } from '@/components/ui/nodegraph/ConnectionLine';
import { ConnectionNode } from '@/components/ui/nodegraph/ConnectionNode';
import { ConnectionPill } from '@/components/ui/nodegraph/ConnectionPill';
import { WIRE_COLOUR } from '@/components/ui/nodegraph/connectionState';
import { HoverCard } from '@/components/ui/nodegraph/HoverCard';
import { RuleGlyphs } from '@/components/ui/nodegraph/RuleGlyph';
import type { WebhookGroupStatFull } from '@/lib/bq';
import type { WebhookFull } from '@/lib/bqTypes';
import { cn } from '@/lib/cn';
import { stagger } from '@/lib/stagger';
import { useRises } from '@/lib/useChangeFlash';
import { ConnectionFigures } from './ConnectionFigures';
import { confirmRemove } from './ConnectionRow';
import { FIXED_LABELS, ruleCards } from './connectionRules';
import {
  connectionLink,
  destinationLabel,
  destinationSub,
  eventsLink,
  routeName,
  routeState,
  sourceLabel,
  STATE_WORDS,
} from './model';

/**
 * One connection as a line from its source to its destination: the name on the line (a pill that opens the
 * connection, with a card of its rules on hover or focus), the rules it set as glyphs, the destination, the
 * last 24 hours, and the switch and a menu for the rest. From `xl` the four sit in a row; below it they stack
 * under a spine. `arrive` is the place in the first load's stagger and is read once; a poll never replays it.
 */
export function ConnectionDiagramRow({
  route,
  enabled,
  removing,
  testing,
  stat,
  grouped,
  arrive,
  multi,
  onToggleEnabled,
  onRemove,
  onTest,
}: {
  route: WebhookFull;
  /** The switch as shown: the optimistic value while a change is in flight. */
  enabled: boolean;
  removing: boolean;
  testing: boolean;
  stat: WebhookGroupStatFull | undefined;
  /** Whether the server gave the 24-hour read at all. */
  grouped: boolean;
  arrive: number | undefined;
  /** More than one connection under the source: the spine and a dot per row. */
  multi: boolean;
  onToggleEnabled: (next: boolean) => void;
  onRemove: () => void;
  onTest: () => void;
}) {
  const [place] = useState(arrive);
  // The comet follows a total that went up between two reads, so it means events really arrived.
  const pulse = useRises(route.successCount);
  const state = routeState(route, enabled);
  const word = STATE_WORDS[state];
  const name = routeName(route);
  const rules = ruleCards(route);
  const fixed = rules
    .filter((rule) => !rule.editable)
    .map((rule) => ({ name: rule.name, label: FIXED_LABELS[rule.name] ?? rule.name }));
  const page = connectionLink(route.id);

  return (
    <li
      aria-busy={removing || undefined}
      style={place === undefined ? undefined : stagger(place)}
      className={cn(
        'relative grid gap-y-2.5 py-3.5 xl:h-[92px] xl:grid-cols-[minmax(0,1fr)_216px_188px_88px] xl:items-center xl:gap-x-4 xl:gap-y-0 xl:py-0 xl:pr-1',
        place !== undefined && 'motion-arrive',
        removing && 'opacity-60'
      )}
    >
      <span
        aria-hidden="true"
        className={cn('absolute top-8 -left-5 h-0.5 w-5 bg-current xl:hidden', WIRE_COLOUR[state])}
      />
      {multi && (
        <span
          aria-hidden="true"
          className="absolute top-[42px] -left-5 hidden size-2 rounded-full bg-line-strong xl:block"
        />
      )}
      <ConnectionLine
        state={state}
        index={place ?? 0}
        pulse={pulse}
        className="justify-start xl:justify-center max-xl:[&>span]:hidden"
      >
        <HoverCard
          label={`${name}, details`}
          trigger={(aria) => (
            <ConnectionPill name={name} state={state} stateLabel={word} to={page} {...aria} />
          )}
        >
          <ConnectionCard
            name={name}
            route={`${sourceLabel(route)} → ${destinationLabel(route)} · ${route.events.join(', ')}`}
            state={state}
            stateLabel={word}
            rules={rules}
            fixed={fixed}
            actions={
              <LinkButton size="sm" to={page}>
                Open
              </LinkButton>
            }
          />
        </HoverCard>
        <RuleGlyphs rules={rules} />
      </ConnectionLine>
      <ConnectionNode
        kind={route.destination === 'queue' ? 'queue' : 'http'}
        icon={route.destination === 'queue' ? ICON.queues : ICON.webhooks}
        name={destinationLabel(route)}
        sub={destinationSub(route)}
        state={state}
      />
      <ConnectionFigures route={route} stat={stat} grouped={grouped} />
      <div className="flex items-center justify-between gap-1 xl:justify-end">
        {removing ? (
          <span role="status" className="text-xs font-semibold text-muted">
            Removing…
          </span>
        ) : (
          <>
            <Toggle
              checked={enabled}
              label={`${enabled ? 'Turn off' : 'Turn on'} connection to ${name}`}
              onChange={onToggleEnabled}
            />
            <ActionMenu
              label={`More for ${name}`}
              items={[
                { label: 'Open', to: page },
                { label: 'Events', to: eventsLink({ route: route.id }) },
                {
                  label: testing ? 'Sending a test event…' : 'Send a test event',
                  disabled: !enabled || testing,
                  hint: enabled
                    ? 'A test event is on its way'
                    : 'Turn the connection on to send a test event',
                  onSelect: onTest,
                },
                {
                  label: 'Remove connection',
                  danger: true,
                  onSelect: () => void confirmRemove(name).then((ok) => ok && onRemove()),
                },
              ]}
            />
          </>
        )}
      </div>
    </li>
  );
}
