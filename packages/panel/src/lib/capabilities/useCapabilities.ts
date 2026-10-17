import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useConnectionStore } from '@/components/dashboard/stores/connectionStore';
import { bq } from '@/lib/bq';
import { isActionSupported, isConceptHidden, isPageAvailable, mayOperate } from './model';
import { type CapabilitiesStatus, useCapabilitiesStore } from './store';
import type { Capabilities } from './types';

/** After a failed load (a 401 that a renewal fixes, a restart): a few quiet retries, then Retry. */
const RETRY_DELAYS_MS = [1500, 4000, 10_000] as const;

/**
 * Loads `/capabilities` once per connection: when the API address or the session changes, not on a
 * timer. Mounted once, in the layout.
 */
export function useCapabilitiesLoader(): { retry: () => void } {
  const baseUrl = useConnectionStore((s) => s.baseUrl);
  const token = useConnectionStore((s) => s.token);
  const [attempt, setAttempt] = useState(0);
  const failures = useRef(0);
  const key = `${baseUrl}\n${token}`;

  useEffect(() => {
    const store = useCapabilitiesStore.getState();
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (attempt === 0 || store.key !== key) {
      failures.current = 0;
      store.begin(key);
    }
    void bq
      .capabilities()
      .then((caps) => {
        if (!cancelled) useCapabilitiesStore.getState().succeed(key, caps);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        useCapabilitiesStore
          .getState()
          .fail(
            key,
            error instanceof Error ? error.message : 'The capabilities could not be loaded.'
          );
        const delay = RETRY_DELAYS_MS[failures.current];
        failures.current += 1;
        if (delay !== undefined) timer = setTimeout(() => setAttempt((n) => n + 1), delay);
      });
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [key, attempt]);

  const retry = useCallback(() => {
    failures.current = 0;
    setAttempt((n) => n + 1);
  }, []);
  return { retry };
}

/** The caller may change things. False until the server has said so, and for a viewer. */
export function useCanOperate(): boolean {
  return useCapabilitiesStore((s) => s.status === 'ready' && mayOperate(s.caps));
}

/** The action is open in this deployment. Controls for a closed action are left out. */
export function useActionSupported(action: string): boolean {
  return useCapabilitiesStore((s) => isActionSupported(s.caps, action));
}

/** The deployment lists the concept as `hidden`: a card that needs it is left out. */
export function useConceptHidden(name: string): boolean {
  return useCapabilitiesStore((s) => isConceptHidden(s.caps, name));
}

/** The DLQ controls this caller gets: none for a viewer, and no retry where the transport has none. */
export function useDlqMutations(): { operator: boolean; retry: boolean } {
  const operator = useCanOperate();
  const retry = useActionSupported('dlq-retry');
  return { operator, retry };
}

export interface CapabilitiesView {
  status: CapabilitiesStatus;
  error: string | null;
  caps: Capabilities;
  /** The caller may change things. Always false until the server has said so. */
  canOperate: boolean;
  /** The page is served by this deployment (and is not just still loading). */
  isPageAvailable: (pathname: string) => boolean;
  /** The action is not closed by this deployment. */
  supports: (action: string) => boolean;
}

export function useCapabilities(): CapabilitiesView {
  const status = useCapabilitiesStore((s) => s.status);
  const error = useCapabilitiesStore((s) => s.error);
  const caps = useCapabilitiesStore((s) => s.caps);
  return useMemo(
    () => ({
      status,
      error,
      caps,
      canOperate: status === 'ready' && mayOperate(caps),
      isPageAvailable: (pathname: string) => isPageAvailable(pathname, caps),
      supports: (action: string) => isActionSupported(caps, action),
    }),
    [status, error, caps]
  );
}
