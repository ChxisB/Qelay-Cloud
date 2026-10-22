import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { confirmInPage } from '@/components/dashboard/stores/confirmStore';
import { Button, IconButton } from '@/components/ui/Button';
import { Toggle } from '@/components/ui/form';
import { IconTrash } from '@/components/ui/icons';
import { LinkButton } from '@/components/ui/LinkButton';
import { Td, Tr } from '@/components/ui/Table';
import { Tag } from '@/components/ui/Tag';
import type { WebhookFull } from '@/lib/bqTypes';
import { formatNumber, formatRelativeTime } from '@/lib/format';
import {
  connectionLink,
  destinationLabel,
  destinationSub,
  eventsLink,
  routeName,
  routeState,
  ruleChips,
  sourceLabel,
} from './model';
import { RouteStatePill } from './RouteStatePill';

/** Asks in the page; the answer is false on Cancel, Escape and the dimmed area. */
export const confirmRemove = (name: string) =>
  confirmInPage({
    question: `Remove the connection to ${name}?`,
    confirmLabel: 'Remove connection',
    danger: true,
  });

/** One connection: where it sends, what it sends, how it is doing, and the few things to do with it. */
export function ConnectionRow({
  route,
  flat = false,
  enabled,
  removing,
  testing,
  trend,
  onToggleEnabled,
  onRemove,
  onTest,
}: {
  route: WebhookFull;
  /** The Table view: the source and the rules are columns of the row, not a heading above it. */
  flat?: boolean;
  /** The switch as shown: the optimistic value while a change is in flight. */
  enabled: boolean;
  removing: boolean;
  testing: boolean;
  /** The last 24 hours, drawn by the page; absent when the server cannot give it, and the column is then left out. */
  trend?: ReactNode;
  onToggleEnabled: (next: boolean) => void;
  onRemove: () => void;
  onTest: () => void;
}) {
  const state = routeState(route, enabled);
  return (
    <Tr>
      {flat && (
        <Td className="max-w-[14rem] truncate font-mono text-[13px]">{sourceLabel(route)}</Td>
      )}
      <Td className="max-w-xs truncate font-mono text-[13px] text-fg">
        <span aria-hidden="true" className="mr-1 text-muted">
          →
        </span>
        <Link to={connectionLink(route.id)} className="text-fg hover:underline">
          {routeName(route)}
        </Link>
        <span className="block font-sans text-[13px] text-muted">
          {route.name && <span className="font-mono">{destinationLabel(route)} · </span>}
          {destinationSub(route)}
        </span>
      </Td>
      {flat && (
        <Td>
          <div className="flex flex-wrap gap-1.5">
            {ruleChips(route).map((chip) => (
              <Tag key={chip}>{chip}</Tag>
            ))}
          </div>
        </Td>
      )}
      <Td className="text-[13px] text-muted">{route.events.join(', ')}</Td>
      <Td>
        <RouteStatePill state={state} />
      </Td>
      {trend !== undefined && <Td>{trend}</Td>}
      <Td className="text-right tnum text-muted">
        <span className="text-success">{formatNumber(route.successCount)}</span>
        {' / '}
        <span className={route.failureCount ? 'font-bold text-danger' : ''}>
          {formatNumber(route.failureCount)}
        </span>
      </Td>
      <Td className="text-right text-[13px] text-muted">
        {formatRelativeTime(route.lastTriggered)}
      </Td>
      <Td>
        <Toggle
          checked={enabled}
          label={`${enabled ? 'Turn off' : 'Turn on'} connection to ${routeName(route)}`}
          onChange={onToggleEnabled}
        />
      </Td>
      <Td className="text-right">
        <div className="flex items-center justify-end gap-2">
          <LinkButton size="sm" to={eventsLink({ route: route.id })}>
            Events
          </LinkButton>
          <Button
            size="sm"
            disabled={!enabled || testing}
            title={enabled ? undefined : 'Turn the connection on to send a test event'}
            onClick={onTest}
          >
            Test
          </Button>
          <IconButton
            aria-label={`Remove connection to ${routeName(route)}`}
            disabled={removing}
            onClick={() => void confirmRemove(routeName(route)).then((ok) => ok && onRemove())}
          >
            <IconTrash className="size-4" />
          </IconButton>
        </div>
      </Td>
    </Tr>
  );
}
