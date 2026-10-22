import { Card, CardHeader } from '@/components/ui/Card';
import { Disclosure } from '@/components/ui/Disclosure';
import { Facts } from '@/components/ui/Facts';
import type { DlqConfig } from '@/lib/bqTypes';
import { FLOW_DLQ_RETENTION_UNAVAILABLE } from '@/lib/flowMutationSafety';
import { formatDuration, formatNumber } from '@/lib/format';

const DAY_MS = 86_400_000;

const keptFor = (ms: number | null) =>
  ms === null
    ? 'For ever'
    : ms % DAY_MS === 0
      ? `${ms / DAY_MS} ${ms === DAY_MS ? 'day' : 'days'}`
      : formatDuration(ms);

/**
 * What happens to a job that has failed all of its attempts. This server accepts no change to any of it
 * (`PUT /queues/:queue/dlq-config` answers 501 or 400), so it is shown as facts, not as a form with a
 * Save button that can only fail.
 */
export function DlqConfigForm({ config }: { config: DlqConfig }) {
  return (
    <Card>
      <CardHeader
        title="Failed job handling"
        sub="What happens to a job once it has failed all of its attempts. The server sets this and it cannot be changed here."
      />
      <Facts
        items={[
          {
            label: 'Retry failed jobs automatically',
            value: config.autoRetry ? 'On' : 'No, they stay in the failed list',
          },
          { label: 'Failed jobs are kept for', value: keptFor(config.maxAge) },
          {
            label: 'Most failed jobs kept',
            value: `${formatNumber(config.maxEntries)}, the oldest go first`,
          },
        ]}
      />
      <Disclosure summary="Why can't I change this?" className="mt-4">
        <div className="space-y-2 text-[13px] text-muted">
          <p>
            Automatic retry stays off: Qelay cannot prove that a failed job has no hidden reverse
            flow dependents before a background retry.
          </p>
          <p>{FLOW_DLQ_RETENTION_UNAVAILABLE}</p>
        </div>
      </Disclosure>
    </Card>
  );
}
