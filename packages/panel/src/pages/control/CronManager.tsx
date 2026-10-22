import { useEffect, useMemo, useState } from 'react';
import { confirmInPage } from '@/components/dashboard/stores/confirmStore';
import { toast } from '@/components/dashboard/stores/toastStore';
import { Banner } from '@/components/ui/Banner';
import { CreateCard } from '@/components/ui/CreateCard';
import { EmptyState, ErrorState, LoadingState, OfflineBanner } from '@/components/ui/feedback';
import { ClockDrawing } from '@/components/ui/illustrations';
import { PageHeader } from '@/components/ui/PageHeader';
import { bq } from '@/lib/bq';
import type { CronFull } from '@/lib/bqTypes';
import { useCanOperate } from '@/lib/capabilities/useCapabilities';
import { usePolledData } from '@/lib/usePolledData';
import { useServerActionGuard } from '@/lib/useServerActionGuard';
import { CronForm } from './cron/CronForm';
import { CRON_PAGE_SIZE, CronTable } from './cron/CronTable';
import { useClampedPage } from './cron/hooks';
import { assertCronDeleteResponse, assertCronNameAvailable } from './cron/model';

export { useClampedPage, useTransientFlag } from './cron/hooks';
export type { CronFormValues } from './cron/model';
export {
  assertCronCreateResponse,
  assertCronDeleteResponse,
  assertCronNameAvailable,
  buildCronBody,
  existingCronNameError,
} from './cron/model';

const EMPTY_CRONS: CronFull[] = [];

export function CronManager() {
  const canOperate = useCanOperate();
  const { data, error, loading, refetch } = usePolledData(() => bq.crons(), []);
  const crons = data?.crons ?? EMPTY_CRONS;
  const existingNames = useMemo(() => new Set(crons.map((cron) => cron.name)), [crons]);
  const pageCount = Math.max(1, Math.ceil(crons.length / CRON_PAGE_SIZE));
  const [safePage, setPage] = useClampedPage(pageCount);
  const [actionError, setActionError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [removing, setRemoving] = useState<Set<string>>(new Set());
  const actionGuard = useServerActionGuard('cron-manager');

  // scopeKey is the connection lifecycle boundary.
  useEffect(() => {
    setActionError(null);
    setRemoving(new Set());
  }, [actionGuard.scopeKey]);

  const remove = async (name: string) => {
    const sure = await confirmInPage({
      question: `Delete cron "${name}"?`,
      detail:
        'It will not be recreated automatically; creating a replacement is a separate action.',
      confirmLabel: 'Delete cron',
      danger: true,
    });
    if (!sure) return;
    const lease = actionGuard.begin(`cron:${name}`);
    if (!lease) return;
    setActionError(null);
    setRemoving((current) => new Set(current).add(name));
    try {
      assertCronDeleteResponse(await bq.deleteCron(name));
      if (!lease.isCurrent()) return;
      toast.success('Cron deleted', name);
      void refetch();
    } catch (caught) {
      if (!lease.isCurrent()) return;
      setActionError((caught as Error).message);
      toast.error('Delete cron failed', (caught as Error).message);
    } finally {
      if (lease.finish()) {
        setRemoving((current) => {
          const next = new Set(current);
          next.delete(name);
          return next;
        });
      }
    }
  };

  return (
    <div>
      {error && data && (
        <OfflineBanner
          message="Cron refresh failed — showing the last successful schedule list."
          onRetry={refetch}
        />
      )}
      <PageHeader
        title="Cron jobs"
        description="Run a job on a schedule: at set times, or every so often."
        live={Boolean(data) && !error}
      />
      {actionError && (
        <div className="mb-4">
          <Banner tone="problem" title="Cron action failed">
            {actionError}
          </Banner>
        </div>
      )}

      {canOperate && (
        <CreateCard
          title="Create schedule"
          sub="Choose the queue, say when to run, and Qelay adds a job each time."
          button="New schedule"
          open={creating}
          onOpenChange={setCreating}
          empty={Boolean(data) && crons.length === 0}
        >
          <CronForm
            existingNames={existingNames}
            onCreate={async (body, isCurrent) => {
              const latest = await bq.crons();
              if (!isCurrent()) throw new Error('Cron creation target changed during preflight');
              assertCronNameAvailable(latest, body.name);
              return bq.createCron(body);
            }}
            onAccepted={() => {
              setCreating(false);
              void refetch();
            }}
            beginCreate={(name) => actionGuard.begin(`cron:${name}`)}
            scopeKey={actionGuard.scopeKey}
          />
        </CreateCard>
      )}

      {error && !data ? (
        <ErrorState error={error} onRetry={refetch} />
      ) : loading && !data ? (
        <LoadingState label="Loading crons…" />
      ) : crons.length === 0 ? (
        <EmptyState
          picture={<ClockDrawing />}
          title="No schedules yet"
          hint={
            canOperate
              ? 'A schedule adds a job to a queue by itself, every few minutes or at set times. Fill in the form above to create the first one.'
              : 'A schedule adds a job to a queue by itself, every few minutes or at set times. None has been created yet.'
          }
        />
      ) : (
        <CronTable
          crons={crons}
          page={safePage}
          removing={removing}
          canRemove={canOperate}
          onPageChange={setPage}
          onRemove={(name) => void remove(name)}
        />
      )}
    </div>
  );
}
