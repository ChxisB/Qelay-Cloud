import {
  type ComponentProps,
  type ComponentType,
  createElement,
  lazy,
  type LazyExoticComponent,
} from 'react';

const failedImports = new Set<() => void>();

/**
 * Give every lazy component whose chunk failed to load a fresh `import()` on
 * its next render. Error boundaries call this when they reset (route change,
 * Copilot close) — never during render, so an offline browser can't spin in a
 * fail → retry → fail loop.
 */
export function resetFailedLazyImports(): void {
  for (const renew of [...failedImports]) renew();
}

/**
 * `React.lazy` caches a rejected import forever: after one failed chunk fetch
 * (network blip, stale hash after a redeploy) every later render re-throws the
 * same error without fetching again, so the only recovery is a full reload —
 * which destroys the dashboard's deliberately memory-only secrets.
 *
 * This wrapper keeps the failure cached until `resetFailedLazyImports()` runs,
 * then swaps in a fresh lazy component so the next render fetches again.
 */
export function retryableLazy<T extends ComponentType<any>>(
  factory: () => Promise<{ default: T }>
): ComponentType<ComponentProps<T>> {
  let current: LazyExoticComponent<T> = lazy(load);

  function renew(): void {
    failedImports.delete(renew);
    current = lazy(load);
  }

  function load(): Promise<{ default: T }> {
    return factory().catch((error: unknown) => {
      failedImports.add(renew);
      throw error;
    });
  }

  function RetryableLazy(props: ComponentProps<T>) {
    return createElement(current, props);
  }
  return RetryableLazy;
}
