import { SectionTabs } from '@/components/SectionTabs';

const KINDS = [
  { to: '/flows', label: 'Job flows' },
  { to: '/workflows', label: 'Workflow runs' },
] as const;

/**
 * Job flows (a parent job that waits for its children) and workflow runs (durable steps) are two
 * engines and one page of the console. The switch shows only when the server offers both.
 */
export function FlowKindTabs({ current }: { current: 'jobs' | 'workflows' }) {
  return (
    <SectionTabs
      label="Kind of flow"
      tabs={KINDS}
      current={current === 'jobs' ? '/flows' : '/workflows'}
    />
  );
}
