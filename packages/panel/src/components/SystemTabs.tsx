import { SYSTEM_TABS } from '@/components/layout/navConfig';
import { SectionTabs } from '@/components/SectionTabs';

/** The server, its database and backups, the MCP bridge, the benchmark and the fleet: the System item of the sidebar. */
export const SystemTabs = ({ current }: { current: (typeof SYSTEM_TABS)[number]['to'] }) => (
  <SectionTabs label="System" tabs={SYSTEM_TABS} current={current} />
);
