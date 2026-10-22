import { Link } from 'react-router-dom';
import { Card, CardHeader } from '@/components/ui/Card';
import { owningExecution } from '@/features/workflows/domain/workflowJob';
import { workflowHref } from '@/features/workflows/domain/workflowUrlState';
import type { JobFull } from '@/lib/bqTypes';
import { useCapabilities } from '@/lib/capabilities/useCapabilities';

/** For a workflow step job: the execution it runs a step of, on the Workflows page. */
export function JobWorkflowLink({ job }: { job: JobFull }) {
  const { isPageAvailable } = useCapabilities();
  const executionId = owningExecution(job);
  if (!executionId || !isPageAvailable('/workflows')) return null;
  return (
    <Card>
      <CardHeader title="Workflow" />
      <dl className="flex flex-wrap items-baseline justify-between gap-2 text-[13px]">
        <dt className="text-[13px] font-semibold text-muted">Runs a step of</dt>
        <dd>
          <Link
            to={workflowHref(executionId)}
            translate="no"
            className="break-all font-mono text-[13px] text-fg underline decoration-dotted hover:decoration-solid"
          >
            {executionId}
          </Link>
        </dd>
      </dl>
    </Card>
  );
}
