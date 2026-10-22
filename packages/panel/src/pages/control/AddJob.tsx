import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { toast } from '@/components/dashboard/stores/toastStore';
import { Banner } from '@/components/ui/Banner';
import { Button } from '@/components/ui/Button';
import { Field, FieldAction, FormRow, Input } from '@/components/ui/form';
import { LinkButton } from '@/components/ui/LinkButton';
import { PageHeader } from '@/components/ui/PageHeader';
import { bq, bulkJobPayloadBudgetError } from '@/lib/bq';
import type { CloneJobState } from '@/lib/cloneJob';
import { usePolledData } from '@/lib/usePolledData';
import { useServerActionGuard } from '@/lib/useServerActionGuard';
import { AddJobCard } from './addJob/AddJobCard';
import { AddJobOptionsCard } from './addJob/AddJobOptionsCard';
import {
  type AddJobFormValues,
  buildAddJobSubmission,
  initialAddJobValues,
} from './addJob/formModel';
import { acceptedBulkIds, acceptedJobId, createdSummary } from './addJob/responses';

export {
  MAX_JOB_DATA_BYTES,
  MAX_JOB_DATA_CHARS,
  parseJobData,
  utf8ByteLength,
} from './addJob/data';
export type { AddJobCloneDefaults } from './addJob/options';
export {
  addJobCloneDefaults,
  parseAddJobNumbers,
  parseRepeat,
  queueNameError,
  resolveBackoff,
} from './addJob/options';
export { acceptedBulkIds, acceptedJobId, createdSummary } from './addJob/responses';

export function AddJob() {
  const {
    data: queues,
    error: queueDiscoveryError,
    refetch: refetchQueues,
  } = usePolledData(() => bq.queues(), [], { intervalMs: 30000 });
  const clone = (useLocation().state as Partial<CloneJobState> | null)?.clone;
  const [values, setValues] = useState<AddJobFormValues>(() => initialAddJobValues(clone));
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [jsonError, setJsonError] = useState<string | null>(null);
  const actionGuard = useServerActionGuard('add-job');
  const setValue = <K extends keyof AddJobFormValues>(key: K, value: AddJobFormValues[K]) =>
    setValues((current) => ({ ...current, [key]: value }));

  // scopeKey is the connection lifecycle boundary.
  useEffect(() => {
    setBusy(false);
    setResult(null);
    setJsonError(null);
  }, [actionGuard.scopeKey]);

  const submit = async () => {
    setResult(null);
    setJsonError(null);
    const submission = buildAddJobSubmission(values);
    if (!submission.ok) {
      if (submission.field === 'data') setJsonError(submission.msg);
      else setResult({ ok: false, msg: submission.msg });
      return;
    }

    const lease = actionGuard.begin();
    if (!lease) return;
    setBusy(true);
    const { target, body, count } = submission;
    try {
      if (count === 1 && body.groupMaxSize === undefined) {
        const response = await bq.addJob(target, body);
        const id = acceptedJobId(response);
        if (!lease.isCurrent()) return;
        setResult({
          ok: true,
          msg: `Accepted job ID ${id} (it may be an existing deduplicated job)`,
        });
        toast.success('Job submission accepted', `${target} · ${id}`);
      } else {
        const bodies = Array.from({ length: count }, () => body);
        const payloadError = bulkJobPayloadBudgetError(bodies);
        if (payloadError) {
          if (lease.isCurrent()) setResult({ ok: false, msg: payloadError });
          return;
        }
        const response = await bq.addJobsBulk(target, bodies);
        const ids = acceptedBulkIds(response, count);
        if (!lease.isCurrent()) return;
        const summary = createdSummary(new Set(ids).size, count);
        setResult(summary);
        toast.success(summary.msg, `in ${target}`);
      }
    } catch (caught) {
      if (!lease.isCurrent()) return;
      setResult({ ok: false, msg: (caught as Error).message });
      toast.error('Add job failed', (caught as Error).message);
    } finally {
      if (lease.finish()) setBusy(false);
    }
  };

  return (
    <div>
      <PageHeader
        title="Add job"
        description="Send a job to a queue by hand: pick the queue, write the data the worker should receive, then press Add job."
        actions={<LinkButton to="/jobs/bulk-add">Bulk import</LinkButton>}
      />
      <div className="flex flex-col gap-6">
        {clone && (
          <Banner tone="info" title="Pre-filled from an existing job.">
            Review the data and options, then enqueue a fresh job.
          </Banner>
        )}
        <form
          className="grid grid-cols-1 gap-6 lg:grid-cols-2"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <AddJobCard
            values={values}
            setValue={setValue}
            queueNames={(queues?.queues ?? []).map((queue) => queue.name)}
            queueDiscoveryError={queueDiscoveryError}
            onRetryQueues={() => void refetchQueues()}
            jsonError={jsonError}
            setJsonError={setJsonError}
          />
          <AddJobOptionsCard values={values} setValue={setValue} />
          <div className="flex flex-col gap-4 lg:col-span-2">
            <FormRow>
              <div className="w-40">
                <Field label="How many jobs" hint="1 to 10,000">
                  <Input
                    type="number"
                    min={1}
                    max={10000}
                    step={1}
                    name="count"
                    value={values.count}
                    onChange={(event) => setValue('count', event.target.value)}
                  />
                </Field>
              </div>
              <FieldAction>
                <Button type="submit" variant="primary" disabled={busy}>
                  {busy ? 'Adding…' : 'Add job'}
                </Button>
              </FieldAction>
            </FormRow>
            {result && (
              <Banner
                tone={result.ok ? 'ok' : 'problem'}
                title={result.ok ? 'Job submission accepted' : 'The job was not added'}
              >
                {result.msg}
              </Banner>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}
