import { GATEWAY_TABS } from '@/components/layout/navConfig';
import { SectionTabs } from '@/components/SectionTabs';

/** The Event gateway item of the sidebar: connections, their events, the numbers and the issues. */
export const GatewayTabs = ({ current }: { current: (typeof GATEWAY_TABS)[number]['to'] }) => (
  <SectionTabs label="Event gateway" tabs={GATEWAY_TABS} current={current} />
);
