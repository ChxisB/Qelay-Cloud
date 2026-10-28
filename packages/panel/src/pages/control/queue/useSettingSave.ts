import { useEffect, useState } from 'react';
import { useConfigSaveGuard } from './configState';

/**
 * The save flow every settings card shares: one save at a time, a "Saved" mark, and the server's own message when it
 * refuses. `run` resolves true when the save worked, so the card can close itself.
 */
export function useSettingSave(ownerKey: string) {
  const save = useConfigSaveGuard(ownerKey);
  const [error, setError] = useState<string | null>(null);
  // A target change clears errors from the previous target.
  useEffect(() => setError(null), [save.scopeKey]);
  const run = async (action: () => Promise<void>, after: () => void | Promise<void>) => {
    const lease = save.start();
    if (!lease) return false;
    try {
      setError(null);
      await action();
      if (!lease.isCurrent()) return false;
      await after();
      save.showSaved(lease);
      return true;
    } catch (caught) {
      if (lease.isCurrent()) setError((caught as Error).message);
      return false;
    } finally {
      save.finish(lease);
    }
  };
  return { save, error, run };
}
