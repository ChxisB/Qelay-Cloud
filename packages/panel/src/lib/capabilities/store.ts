import { create } from 'zustand';
import { type Capabilities, FAIL_CLOSED } from './types';

export type CapabilitiesStatus = 'loading' | 'ready' | 'error';

interface CapabilitiesState {
  status: CapabilitiesStatus;
  /** The server's answer; `FAIL_CLOSED` until there is one. */
  caps: Capabilities;
  error: string | null;
  /** The connection the answer belongs to, so a stale answer cannot overwrite a newer one. */
  key: string | null;
  begin: (key: string) => void;
  succeed: (key: string, caps: Capabilities) => void;
  fail: (key: string, message: string) => void;
}

export const useCapabilitiesStore = create<CapabilitiesState>((set, get) => ({
  status: 'loading',
  caps: FAIL_CLOSED,
  error: null,
  key: null,
  begin: (key) => set({ status: 'loading', caps: FAIL_CLOSED, error: null, key }),
  succeed: (key, caps) => {
    if (get().key === key) set({ status: 'ready', caps, error: null });
  },
  fail: (key, message) => {
    if (get().key === key) set({ status: 'error', caps: FAIL_CLOSED, error: message });
  },
}));
