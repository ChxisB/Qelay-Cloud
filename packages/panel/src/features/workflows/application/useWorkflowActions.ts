import { useCallback, useState } from 'react';
import { toast } from '@/components/dashboard/stores/toastStore';
import { useServerActionGuard } from '@/lib/useServerActionGuard';
import type { WorkflowActionBody, WorkflowActionName } from '../domain/workflowWire';
import type { LoadedWorkflow } from './useWorkflowData';
import { describeActionError, describeActionResult, type WorkflowNotice } from './workflowMessages';
import type { WorkflowRepository } from './WorkflowRepository';

interface Options {
  repository: WorkflowRepository;
  /** The execution the buttons belong to: one action at a time per execution, across remounts. */
  executionId: string;
  /** The execution as it was read: the actions apply to what the operator sees. */
  loaded: LoadedWorkflow | null;
  /** Read the execution again. */
  reload: () => void;
}

/**
 * Runs the action buttons of an execution: one at a time, each reported, and the execution reread after it.
 * The lock outlives the page (leaving and coming back does not free it while a request is out) and is
 * dropped for a request that was sent to another server. The version the server checks makes a repeat
 * harmless, but an operator should not have to rely on that.
 */
export function useWorkflowActions({ repository, executionId, loaded, reload }: Options) {
  const [pending, setPending] = useState<WorkflowActionName | null>(null);
  const [notice, setNotice] = useState<WorkflowNotice | null>(null);
  const guard = useServerActionGuard(`workflow:${executionId}`);

  const run = useCallback(
    async (request: WorkflowActionBody): Promise<boolean> => {
      if (!loaded) return false;
      const lease = guard.begin('action');
      if (!lease) return false;
      setPending(request.action);
      setNotice(null);
      try {
        const result = await repository.act(loaded.target, loaded.detail.execution.id, request);
        const text = describeActionResult(result);
        toast.success(text);
        if (lease.isCurrent()) setNotice({ kind: 'success', text, reload: true });
        reload();
        return true;
      } catch (caught) {
        const next = describeActionError(caught);
        toast.error(next.text);
        if (lease.isCurrent()) setNotice(next);
        if (next.reload) reload();
        return false;
      } finally {
        if (lease.finish()) setPending(null);
      }
    },
    [guard, repository, loaded, reload]
  );

  const dismiss = useCallback(() => setNotice(null), []);
  return { pending, notice, run, dismiss };
}
