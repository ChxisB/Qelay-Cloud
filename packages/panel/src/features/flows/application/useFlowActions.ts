import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from '@/components/dashboard/stores/toastStore';
import type { FlowActionBody, FlowActionName } from '../domain/flowWire';
import { describeActionError, describeActionResult, type FlowNotice } from './flowMessages';
import type { FlowRepository } from './FlowRepository';
import type { LoadedFlow } from './useFlowExplorer';

interface Options {
  repository: FlowRepository;
  /** The flow as it was read: the actions apply to what the operator sees. */
  loaded: Pick<LoadedFlow, 'target' | 'view'> | null;
  /** Read the flow again. */
  reload: () => void;
  /** The flow no longer exists. */
  onRemoved: () => void;
}

/** Runs the action buttons of a flow: one at a time, each reported, and the flow reread after it. */
export function useFlowActions({ repository, loaded, reload, onRemoved }: Options) {
  const [pending, setPending] = useState<FlowActionName | null>(null);
  const [notice, setNotice] = useState<FlowNotice | null>(null);
  const busy = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const run = useCallback(
    async (request: FlowActionBody) => {
      if (!loaded || busy.current) return;
      busy.current = true;
      setPending(request.action);
      setNotice(null);
      try {
        const result = await repository.act(loaded.target, loaded.view.root, request);
        const text = describeActionResult(result);
        toast.success(text);
        if (mounted.current) setNotice({ kind: 'success', text, reload: true });
        if (result.action === 'remove') onRemoved();
        else reload();
      } catch (caught) {
        const next = describeActionError(caught);
        toast.error(next.text);
        if (mounted.current) setNotice(next);
        if (next.reload) reload();
      } finally {
        busy.current = false;
        if (mounted.current) setPending(null);
      }
    },
    [repository, loaded, reload, onRemoved]
  );

  const dismiss = useCallback(() => setNotice(null), []);
  return { pending, notice, run, dismiss };
}
