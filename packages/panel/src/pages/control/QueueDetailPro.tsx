import { useCallback, useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { confirmInPage } from '@/components/dashboard/stores/confirmStore';
import { toast } from '@/components/dashboard/stores/toastStore';
import { iconButtonClass } from '@/components/ui/Button';
import { Disclosure } from '@/components/ui/Disclosure';
import { EmptyState, ErrorState, LoadingState, OfflineBanner } from '@/components/ui/feedback';
import { IconArrowRight, IconChevronLeft } from '@/components/ui/icons';
import { LinkButton } from '@/components/ui/LinkButton';
import { LinkTabs } from '@/components/ui/LinkTabs';
import { PageHeader } from '@/components/ui/PageHeader';
import { StatCard } from '@/components/ui/StatCard';
import { StatusPill } from '@/components/ui/StatusBadge';
import { QueueOperationsPanel } from '@/features/queue-operations/ui/QueueOperationsPanel';
import { bq } from '@/lib/bq';
import type { JobFull } from '@/lib/bqTypes';
import { useCanOperate, useConceptHidden } from '@/lib/capabilities/useCapabilities';
import { errorRate, formatNumber } from '@/lib/format';
import { usePolledData } from '@/lib/usePolledData';
import { assertSuccessfulMutationResponse, useServerActionGuard } from '@/lib/useServerActionGuard';
import { STATE_LABEL } from './jobsPro/model';
import type { RunConfirm } from './queue/queueActionModel';
import { assertQueueDetail } from './queue/queueDiscovery';
import { QueueSettings } from './queue/QueueSettings';
import { QUEUE_DETAIL_COUNT_KEYS, QUEUE_DETAIL_RECENT_STATES } from './queueDetail/model';
import {
  BacklogDepthCard,
  PriorityHistogram,
  RecentQueueJobs,
} from './queueDetail/QueueDetailSections';
import { QueueLifecycle } from './queueDetail/QueueLifecycle';
import { useQueueDepth } from './queueDetail/useQueueDepth';

/**
 * Pro per-queue page, reached by drilling into a queue from the Overview or Queues list
 * (`/queues/:name`), deep-linkable. Two tabs: Overview (counts, a live backlog-depth sparkline,
 * recent jobs and jump-off links to this queue's Jobs and DLQ views) and Settings
 * (`?tab=settings`, operators only: plain-language cards, one main action each; this is where
 * the old Queue control page went). Monitoring and settings stay on separate tabs on purpose.
 */
export function QueueDetailPro() {
  const { name = '' } = useParams();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const actionGuard = useServerActionGuard(`queue:${name}`);
  const canOperate = useCanOperate();
  // The SDK operations card calls a local control agent, which a managed deployment does not have.
  const operationsHidden = useConceptHidden('queueOperations');
  const [operationsRevision, setOperationsRevision] = useState(0);
  const [params] = useSearchParams();
  const tab = canOperate && params.get('tab') === 'settings' ? 'settings' : 'overview';
  // scopeKey is the queue and connection lifecycle boundary.
  useEffect(() => {
    setBusy(false);
    setMsg(null);
  }, [actionGuard.scopeKey]);

  const fetcher = useCallback(async () => {
    if (!name) return null;
    // v2.9.3 synthesizes an empty detail for any valid queue name. Establish
    // membership first so a typo never exposes destructive controls for a
    // queue that does not actually exist.
    const summary = await bq.queuesSummary();
    if (!summary.some((queue) => queue.name === name)) {
      return {
        queue: name,
        exists: false as const,
        detail: null,
        stall: null,
        dlq: null,
        jobs: [] as JobFull[],
        recentJobsError: null as string | null,
      };
    }
    const [detail, stall, dlq, recentJobs] = await Promise.all([
      bq.queueDetail(name, false),
      bq.getStallConfig(name).catch(() => null),
      bq.getDlqConfig(name).catch(() => null),
      bq
        .jobsList(name, QUEUE_DETAIL_RECENT_STATES, 12)
        .then((result) => ({ jobs: result.jobs ?? [], error: null as string | null }))
        .catch((error: unknown) => ({
          jobs: [] as JobFull[],
          error: (error as Error).message || 'Unknown error',
        })),
    ]);
    assertQueueDetail(detail, name);
    // Tag with the queue it was fetched for, so a param change can't render (or
    // save) queue A's data under queue B for one round-trip.
    return {
      queue: name,
      exists: true as const,
      detail,
      stall: stall?.config ?? null,
      dlq: dlq?.config ?? null,
      jobs: recentJobs.jobs,
      recentJobsError: recentJobs.error,
    };
  }, [name]);
  const { data: raw, error, loading, refetch } = usePolledData(fetcher, [name]);
  const data = raw?.queue === name ? raw : null;

  const { depth, trend } = useQueueDepth(name, data?.detail?.counts);

  const run = async (
    label: string,
    fn: () => Promise<unknown>,
    confirm?: RunConfirm,
    onSuccess?: () => void
  ) => {
    if (confirm && !(await confirmInPage(confirm))) return;
    const lease = actionGuard.begin();
    if (!lease) return;
    setBusy(true);
    setMsg(null);
    try {
      const summary = await bq.queuesSummary();
      if (!lease.isCurrent()) return;
      if (!summary.some((candidate) => candidate.name === name)) {
        throw new Error(`Queue "${name}" no longer exists`);
      }
      const response = await fn();
      assertSuccessfulMutationResponse(response, label);
      if (!lease.isCurrent()) return;
      const count = response.count;
      if (count !== undefined && (!Number.isSafeInteger(count) || (count as number) < 0)) {
        throw new Error(`${label} returned an invalid count`);
      }
      const text = `${label}${count != null ? `: ${count}` : ' ✓'}`;
      setMsg({ ok: true, text });
      toast.success(text, name);
      onSuccess?.();
      setOperationsRevision((revision) => revision + 1);
      refetch();
    } catch (e) {
      if (!lease.isCurrent()) return;
      const text = (e as Error).message;
      setMsg({ ok: false, text });
      toast.error(`${label} failed`, text);
    } finally {
      if (lease.finish()) setBusy(false);
    }
  };

  const base = `/queues/${encodeURIComponent(name)}`;
  const detail = data?.detail;
  const c = detail?.counts;
  // Keep null when nothing has been processed — "0.00%" from zero data is a
  // claim, not a measurement (errorRate's contract; OverviewPro follows it too).
  const rate = c ? errorRate(c.completed ?? 0, c.failed ?? 0) : null;

  return (
    <div>
      <PageHeader
        title={<span className="font-mono">{name}</span>}
        description="How this queue is doing right now. Use Settings to change how it behaves."
        live={
          data?.exists === true &&
          !!data.detail &&
          !!data.stall &&
          !!data.dlq &&
          !data.recentJobsError &&
          !error
        }
        back={
          <Link to="/queues" aria-label="Back to queues" className={iconButtonClass()}>
            <IconChevronLeft className="size-4" />
          </Link>
        }
        actions={
          data?.exists === true ? (
            <>
              <LinkButton
                to={`/jobs?queue=${encodeURIComponent(name)}`}
                size="sm"
                className="gap-1"
              >
                See jobs <IconArrowRight className="size-3.5" />
              </LinkButton>
              <LinkButton to={`/dlq?queue=${encodeURIComponent(name)}`} size="sm" className="gap-1">
                See failed jobs <IconArrowRight className="size-3.5" />
              </LinkButton>
            </>
          ) : undefined
        }
      />

      {error && data && (
        <OfflineBanner
          message="Queue refresh failed — showing the last successful snapshot."
          onRetry={refetch}
        />
      )}

      {error && !data ? (
        <ErrorState error={error} onRetry={refetch} />
      ) : loading && !data ? (
        <LoadingState label={`Loading ${name}…`} />
      ) : data?.exists === false || !detail || !c ? (
        !error && (
          <EmptyState
            title="Queue not found"
            hint={`No queue named "${name}" exists — it may have been obliterated, or the link is stale.`}
            action={
              <LinkButton to="/queues" size="sm">
                Back to queues
              </LinkButton>
            }
          />
        )
      ) : (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <StatusPill state={detail.paused ? 'waiting' : 'active'}>
              {detail.paused ? 'Paused' : 'Active'}
            </StatusPill>
            {msg && (
              <span
                role="status"
                className={msg.ok ? 'text-sm text-success' : 'text-sm text-danger'}
              >
                {msg.text}
              </span>
            )}
          </div>
          {canOperate && (
            <LinkTabs
              label="Page section"
              tabs={[
                { to: base, label: 'Overview', current: tab === 'overview' },
                { to: `${base}?tab=settings`, label: 'Settings', current: tab === 'settings' },
              ]}
            />
          )}

          {tab === 'overview' ? (
            <>
              <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
                {QUEUE_DETAIL_COUNT_KEYS.map((k) => (
                  <StatCard
                    key={k}
                    label={STATE_LABEL[k]}
                    value={formatNumber(c[k])}
                    tone={k === 'failed' && c.failed ? 'red' : 'default'}
                    compact
                  />
                ))}
              </div>

              <QueueLifecycle counts={c} />
              <RecentQueueJobs name={name} jobs={data.jobs} error={data.recentJobsError} />
              <PriorityHistogram counts={detail.priorityCounts} />
              <BacklogDepthCard name={name} depth={depth} trend={trend} rate={rate} />

              {!canOperate && (
                <p className="mb-6 text-sm text-muted">
                  You are signed in as a viewer, so the queue settings are not shown.
                </p>
              )}
            </>
          ) : (
            <>
              <QueueSettings
                key={name}
                queue={name}
                paused={detail.paused}
                busy={busy}
                run={run}
                stall={data.stall}
                dlq={data.dlq}
                onRetry={refetch}
                onStallSaved={() => {
                  setMsg({ ok: true, text: 'Stall config saved ✓' });
                  toast.success('Stall config saved', name);
                }}
                onDlqSaved={() => {
                  setMsg({ ok: true, text: 'Failed job limits saved ✓' });
                  toast.success('Failed job limits saved', name);
                  refetch();
                }}
              />
              {!operationsHidden && (
                <Disclosure summary="Developer tools" className="mb-6">
                  <QueueOperationsPanel
                    key={`${actionGuard.scopeKey}:sdk-operations`}
                    queue={name}
                    refreshKey={operationsRevision}
                    onApplied={() => setOperationsRevision((revision) => revision + 1)}
                  />
                </Disclosure>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
