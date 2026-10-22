import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Select } from '@/components/ui/form';
import { IconDownload } from '@/components/ui/icons';
import { LinkButton } from '@/components/ui/LinkButton';
import { PageHeader } from '@/components/ui/PageHeader';
import { SearchField } from '@/components/ui/SearchField';
import { flowHref } from '@/features/flows/domain/flowUrlState';
import type { JobFull } from '@/lib/bqTypes';
import { buildCloneState } from '@/lib/cloneJob';
import { downloadJson } from '@/lib/exportFile';
import type { InspectorResult, LookupMode } from './types';

interface JobInspectorHeaderProps {
  job: JobFull | null;
  result: InspectorResult;
  idInput: string;
  lookupBy: LookupMode;
  loading: boolean;
  busy: boolean;
  onInputChange: (value: string) => void;
  onModeChange: (mode: LookupMode) => void;
  onSubmit: (raw: string) => void;
}

export function JobInspectorHeader({
  job,
  result,
  idInput,
  lookupBy,
  loading,
  busy,
  onInputChange,
  onModeChange,
  onSubmit,
}: JobInspectorHeaderProps) {
  const hasFlowRelationship = Boolean(
    job && (job.flowRoot || (job.childrenIds?.length ?? 0) > 0 || job.parentId)
  );

  return (
    <>
      <PageHeader
        title="Job inspector"
        description="Look up any job by ID and drive its full lifecycle."
        actions={
          job ? (
            <>
              {hasFlowRelationship && (
                <LinkButton size="sm" to={flowHref(job.flowRoot ?? job.id, job.id)}>
                  View flow
                </LinkButton>
              )}
              <LinkButton
                size="sm"
                to="/add-job"
                state={buildCloneState(job)}
                title="Enqueue a new job pre-filled from this one"
              >
                Clone
              </LinkButton>
              <Button
                size="sm"
                onClick={() =>
                  downloadJson(
                    `job-${job.id}`,
                    result.fetched ? { ...job, result: result.value } : job
                  )
                }
              >
                <IconDownload className="size-4" /> Download JSON
              </Button>
            </>
          ) : undefined
        }
      />

      <section aria-label="Look up a job" className="mb-6">
        <Card>
          <div className="flex flex-wrap items-center gap-3">
            <div className="w-48">
              <Select
                name="job-lookup-mode"
                autoComplete="off"
                value={lookupBy}
                aria-label="Lookup mode"
                onChange={(event) => onModeChange(event.target.value as LookupMode)}
              >
                <option value="id">By job ID</option>
                <option value="custom">By custom ID</option>
              </Select>
            </div>
            <SearchField
              containerClassName="min-w-56 flex-1"
              className="font-mono"
              value={idInput}
              aria-label={lookupBy === 'custom' ? 'Custom job ID' : 'Job ID'}
              name="job-lookup-id"
              autoComplete="off"
              spellCheck={false}
              maxLength={1024}
              onInput={(event) => onInputChange(event.currentTarget.value)}
              onKeyDown={(event) => event.key === 'Enter' && onSubmit(idInput)}
              placeholder={
                lookupBy === 'custom'
                  ? 'custom / idempotency id — Enter to look up'
                  : 'job id (UUID) — Enter to look up'
              }
            />
            <Button variant="primary" disabled={loading || busy} onClick={() => onSubmit(idInput)}>
              Look up
            </Button>
          </div>
        </Card>
      </section>
    </>
  );
}
