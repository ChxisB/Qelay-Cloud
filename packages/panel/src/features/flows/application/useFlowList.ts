import { useCallback, useEffect, useState } from 'react';
import { useConnectionStore } from '@/components/dashboard/stores/connectionStore';
import { FLOW_PAGE_SIZE } from '../domain/flowConstants';
import type { FlowList } from '../domain/flowWire';
import { controlFlowRepository } from '../infrastructure/controlFlowRepository';
import type { FlowRepository } from './FlowRepository';

/** The flows of the namespace, newest first, a page at a time. */
export function useFlowList(repository: FlowRepository = controlFlowRepository) {
  const baseUrl = useConnectionStore((state) => state.baseUrl);
  const token = useConnectionStore((state) => state.token);
  const [page, setPage] = useState(0);
  const [list, setList] = useState<FlowList | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const [reloads, setReloads] = useState(0);

  // A new connection is a different namespace: what was listed is not shown against it.
  useEffect(() => {
    void baseUrl;
    void token;
    setList(null);
    setPage(0);
  }, [baseUrl, token]);

  useEffect(() => {
    void baseUrl;
    void token;
    void reloads;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    repository
      .list({ limit: FLOW_PAGE_SIZE, offset: page * FLOW_PAGE_SIZE }, controller.signal)
      .then(
        (next) => {
          if (controller.signal.aborted) return;
          setList(next);
          setLoading(false);
        },
        (caught: unknown) => {
          if (controller.signal.aborted) return;
          setError(caught instanceof Error ? caught : new Error('Failed to list flows'));
          setLoading(false);
        }
      );
    return () => controller.abort();
  }, [repository, page, baseUrl, token, reloads]);

  const reload = useCallback(() => setReloads((count) => count + 1), []);
  return { list, page, setPage, loading, error, reload };
}
