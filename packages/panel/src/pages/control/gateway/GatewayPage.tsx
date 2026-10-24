import type { ComponentProps, ReactNode } from 'react';
import { GatewayTabs } from '@/components/GatewayTabs';
import { PageHeader } from '@/components/ui/PageHeader';

/** The frame of every Event gateway screen: the title, the tab bar, then the screen itself. */
export function GatewayPage({
  current,
  live,
  actions,
  children,
}: {
  current: ComponentProps<typeof GatewayTabs>['current'];
  live?: boolean;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div>
      <PageHeader
        title="Event gateway"
        description="Requests sent to your inbound sources, passed on to an address or a queue, with the history of every attempt."
        live={live}
        actions={actions}
      />
      <GatewayTabs current={current} />
      {children}
    </div>
  );
}
