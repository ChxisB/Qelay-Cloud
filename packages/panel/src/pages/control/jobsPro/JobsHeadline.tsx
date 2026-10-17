import { formatRelativeTime } from '@/lib/format';
import { useNow } from '@/lib/useNow';

/** "15 jobs in emails · updated 2s ago". Ticks on its own so the page doesn't re-render each second. */
export function JobsHeadline({ text, updatedAt }: { text: string; updatedAt: number | null }) {
  const now = useNow(1000);
  return (
    <>
      {text}
      {updatedAt != null && ` · updated ${formatRelativeTime(updatedAt, Math.max(now, updatedAt))}`}
    </>
  );
}
