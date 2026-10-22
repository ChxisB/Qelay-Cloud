import type { ReactNode } from 'react';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import type { WebhookPauseMode } from '@/lib/bq';
import type { WebhookFull } from '@/lib/bqTypes';
import { routeState } from './model';

function Section({
  title,
  action,
  children,
}: {
  title: string;
  action: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card>
      <CardHeader title={title} headingLevel={3} />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="min-w-0 flex-[1_1_320px] text-sm text-muted">{children}</p>
        {action}
      </div>
    </Card>
  );
}

/**
 * The two ways to stop a connection, each with its own words. Pause holds: events keep being collected and
 * Resume sends them. Disable ignores: events that happen while it is off are never collected. A connection
 * that stopped after failures is a hold, so Resume is what it offers; a disabled one offers Enable.
 */
export function ConnectionPause({
  route,
  enabled,
  onSet,
}: {
  route: WebhookFull;
  enabled: boolean;
  onSet: (enabled: boolean, mode?: WebhookPauseMode) => void;
}) {
  const state = routeState(route, enabled);
  if (state === 'active') {
    return (
      <>
        <Section
          title="Pause"
          action={
            <Button size="sm" onClick={() => onSet(false, 'hold')}>
              Pause
            </Button>
          }
        >
          Events keep being collected while it is paused, and Resume sends them. An event not sent
          within 24 hours of being due expires.
        </Section>
        <Section
          title="Disable"
          action={
            <Button size="sm" onClick={() => onSet(false, 'ignore')}>
              Disable
            </Button>
          }
        >
          Events that happen while it is disabled are ignored: they are never collected, so enabling
          it sends nothing from the time it was off.
        </Section>
      </>
    );
  }
  return state === 'off' ? (
    <Section
      title="Disabled"
      action={
        <Button size="sm" variant="primary" onClick={() => onSet(true)}>
          Enable
        </Button>
      }
    >
      This connection is disabled, so events that happen now are ignored. Enable it to send events
      from now on.
    </Section>
  ) : (
    <Section
      title={state === 'held' ? 'Paused' : 'Paused after failures'}
      action={
        <Button size="sm" variant="primary" onClick={() => onSet(true)}>
          Resume
        </Button>
      }
    >
      {state === 'held'
        ? 'Events are being collected. Resume sends what was held; an event not sent within 24 hours of being due expires.'
        : `${route.disabledReason ?? 'It failed too often.'} Events are being collected. Resume once the receiver works, and what was held is sent.`}
    </Section>
  );
}
