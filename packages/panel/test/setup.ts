// Test preload: provide localStorage/sessionStorage shims so modules that import the zustand
// persist stores (e.g. connectionStore, pulled in by lib/sse and lib/api) load
// cleanly under `bun test`.
function ensureStorage(name: 'localStorage' | 'sessionStorage'): void {
  let usable = false;
  try {
    const probe = '__bq_test_storage_probe__';
    globalThis[name].setItem(probe, '1');
    globalThis[name].removeItem(probe);
    usable = true;
  } catch {
    // Bun may expose a storage object whose methods throw unless a backing file was configured,
    // or none at all. `typeof` alone therefore is not enough.
  }
  if (usable) return;
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, name, {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, String(v)),
      removeItem: (k: string) => store.delete(k),
      clear: () => store.clear(),
      key: (index: number) => Array.from(store.keys())[index] ?? null,
      get length() {
        return store.size;
      },
    },
  });
}

ensureStorage('localStorage');
// The sign-in flow keeps its in-flight state (PKCE verifier, nonce) in sessionStorage.
ensureStorage('sessionStorage');

// Pages hide their mutation controls from a caller who may not operate, and from everyone until
// the server has said so. Most page tests are about those controls, so the default is an
// operator; the capability tests set their own answer and put this one back afterwards.
import { beforeEach } from 'bun:test';
import { useCapabilitiesStore } from '../src/lib/capabilities/store';
import { DEMO_CAPABILITIES } from '../src/lib/capabilities/types';

export function resetCapabilitiesForTests(): void {
  useCapabilitiesStore.setState({
    status: 'ready',
    caps: DEMO_CAPABILITIES,
    error: null,
    key: 'test',
  });
}
resetCapabilitiesForTests();
// The layout loads the real answer into the same store, and test files share the module registry:
// every test starts from the operator default, whatever the one before it rendered.
try {
  beforeEach(resetCapabilitiesForTests);
} catch {
  // The preload also runs in the child processes some tests spawn, where there is no runner.
}
