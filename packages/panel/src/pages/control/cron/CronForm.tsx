import { useEffect, useState } from 'react';
import { confirmInPage } from '@/components/dashboard/stores/confirmStore';
import { toast } from '@/components/dashboard/stores/toastStore';
import { Button } from '@/components/ui/Button';
import { Disclosure } from '@/components/ui/Disclosure';
import { IconCheck } from '@/components/ui/icons';
import type { CreateCronBody } from '@/lib/bq';
import type { ServerActionLease } from '@/lib/useServerActionGuard';
import { CronAdvancedFields } from './CronAdvancedFields';
import { CronPrimaryFields } from './CronPrimaryFields';
import { useTransientFlag } from './hooks';
import {
  assertCronCreateResponse,
  buildCronBody,
  type CronFormValues,
  existingCronNameError,
} from './model';

const INITIAL_VALUES: CronFormValues = {
  name: '',
  jobName: 'default',
  queue: '',
  mode: 'cron',
  schedule: '',
  every: '',
  dataText: '{}',
  timezone: '',
  priority: '',
  preventOverlap: true,
  skipIfNoWorker: false,
  maxLimit: '',
  immediately: false,
  skipMissedOnRestart: true,
  uniqueKey: '',
  dedupTtl: '',
  dedupExtend: false,
  dedupReplace: false,
  jobMaxAttempts: '',
  jobBackoff: '',
  jobTimeout: '',
  jobDelay: '',
  jobStallTimeout: '',
  jobRemoveOnComplete: false,
  jobRemoveOnFail: false,
};

export function CronForm({
  onCreate,
  onAccepted,
  beginCreate,
  scopeKey,
  existingNames,
}: {
  onCreate: (body: CreateCronBody, isCurrent: () => boolean) => Promise<unknown>;
  onAccepted: () => void;
  beginCreate: (name: string) => ServerActionLease | null;
  scopeKey: string;
  existingNames: ReadonlySet<string>;
}) {
  const [values, setValues] = useState(INITIAL_VALUES);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { on: created, fire: fireCreated, reset: resetCreated } = useTransientFlag(3000);
  const setValue = <K extends keyof CronFormValues>(key: K, value: CronFormValues[K]) =>
    setValues((current) => ({ ...current, [key]: value }));

  // scopeKey is the lifecycle boundary.
  /* oxlint-disable react/exhaustive-deps -- scopeKey alone defines this reset lifecycle */
  useEffect(() => {
    setBusy(false);
    setError(null);
    resetCreated();
  }, [scopeKey]);
  /* oxlint-enable react/exhaustive-deps */

  const nameConflict = existingCronNameError(values.name, existingNames);
  const submit = async () => {
    setError(null);
    resetCreated();
    const built = buildCronBody(values);
    if (!built.ok) {
      setError(built.msg);
      return;
    }
    const conflict = existingCronNameError(built.body.name, existingNames);
    if (conflict) {
      setError(conflict);
      return;
    }
    const sure = await confirmInPage({
      question: `Create the schedule "${built.body.name}"?`,
      detail:
        'The dashboard checks the name just before saving, but if someone else creates a schedule with this exact name at the same moment, one of them will overwrite the other. Continue only if that is acceptable.',
      confirmLabel: 'Create schedule',
    });
    if (!sure) return;

    const lease = beginCreate(built.body.name);
    if (!lease) return;
    setBusy(true);
    try {
      const response = await onCreate(built.body, lease.isCurrent);
      assertCronCreateResponse(response, built.body);
      if (!lease.isCurrent()) return;
      setValues((current) => ({ ...current, name: '', schedule: '', every: '' }));
      fireCreated();
      toast.success('Schedule created', built.body.name);
      onAccepted();
    } catch (caught) {
      if (lease.isCurrent()) setError((caught as Error).message);
    } finally {
      if (lease.finish()) setBusy(false);
    }
  };

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <CronPrimaryFields values={values} setValue={setValue} />
      <Disclosure summary="Advanced options: timezone, overlap, duplicates, retries">
        <CronAdvancedFields values={values} setValue={setValue} />
      </Disclosure>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="primary" disabled={busy || !!nameConflict}>
          {busy ? 'Saving…' : nameConflict ? 'Name already exists' : 'Create schedule'}
        </Button>
        {nameConflict && !error && (
          <span role="alert" className="max-w-2xl text-[13px] font-semibold text-warning">
            {nameConflict}
          </span>
        )}
        {error && (
          <span role="alert" className="text-[13px] font-semibold text-danger">
            {error}
          </span>
        )}
        {created && (
          <span
            role="status"
            className="motion-pop inline-flex items-center gap-1 text-[13px] font-semibold text-success"
          >
            <IconCheck className="size-4" />
            Schedule created
          </span>
        )}
      </div>
      <Disclosure summary="About schedule names">
        <p className="text-[13px] text-muted">
          Each name must be unique across the whole server. If the name is already taken, this form
          stops and says so. In the rare case that someone else creates the same name at the same
          moment, one of the two schedules replaces the other.
        </p>
      </Disclosure>
    </form>
  );
}
