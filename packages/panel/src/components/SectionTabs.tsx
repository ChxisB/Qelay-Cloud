import { LinkTabs } from '@/components/ui/LinkTabs';
import { useCapabilities } from '@/lib/capabilities/useCapabilities';

export type SectionTab = { to: string; label: string };

/**
 * The pages of one sidebar item, as a tab bar. Each is its own page and path (a bookmark, a back
 * button), so only the open one is mounted and polls. A page this deployment closes is left out,
 * and a lone page is not a switch.
 */
export function SectionTabs({
  label,
  tabs,
  current,
}: {
  label: string;
  tabs: readonly SectionTab[];
  current: string;
}) {
  const { isPageAvailable } = useCapabilities();
  const open = tabs.filter((tab) => isPageAvailable(tab.to));
  if (open.length < 2) return null;
  return (
    <LinkTabs label={label} tabs={open.map((tab) => ({ ...tab, current: tab.to === current }))} />
  );
}
