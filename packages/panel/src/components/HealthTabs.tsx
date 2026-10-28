import { HEALTH_TABS } from '@/components/layout/navConfig';
import { SectionTabs } from '@/components/SectionTabs';

/** Is the deployment healthy: the reports behind the Health item of the sidebar. */
export const HealthTabs = ({ current }: { current: (typeof HEALTH_TABS)[number]['to'] }) => (
  <SectionTabs label="Health" tabs={HEALTH_TABS} current={current} />
);
