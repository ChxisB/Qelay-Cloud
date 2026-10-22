import { type RefObject, useRef } from 'react';
import { type ConfirmOptions, confirmInPage } from '@/components/dashboard/stores/confirmStore';

/**
 * Asks in the page before an operation. The question can stay open while the connection changes, so an answer
 * counts only if the panel is still mounted on the scope it was asked on. Only one question is open at a time.
 */
export function useScopedConfirm<Scope>(
  scopeRef: RefObject<Scope>,
  mounted: RefObject<boolean>
): (options: ConfirmOptions) => Promise<boolean> {
  const asking = useRef(false);
  return async (options) => {
    if (asking.current) return false;
    asking.current = true;
    const scope = scopeRef.current;
    try {
      return (await confirmInPage(options)) && mounted.current && scopeRef.current === scope;
    } finally {
      asking.current = false;
    }
  };
}
