import { useCallback, useEffect, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  patchWorkflowSearchParams,
  readWorkflowUrlState,
  type WorkflowUrlPatch,
  workflowSearchParams,
} from '../domain/workflowUrlState';

/** The page's filters, paging and open execution, kept in its address so a view can be shared. */
export function useWorkflowUrlState() {
  const [params, setParams] = useSearchParams();
  const serialized = params.toString();
  const value = useMemo(() => readWorkflowUrlState(new URLSearchParams(serialized)), [serialized]);
  const canonical = useMemo(() => workflowSearchParams(value).toString(), [value]);

  // An address with a value the page does not know is rewritten to the view it shows.
  useEffect(() => {
    if (canonical !== serialized) setParams(canonical, { replace: true });
  }, [canonical, serialized, setParams]);

  const update = useCallback(
    (patch: WorkflowUrlPatch, replace = false) =>
      setParams((current) => patchWorkflowSearchParams(current, patch), { replace }),
    [setParams]
  );
  return { ...value, update };
}
