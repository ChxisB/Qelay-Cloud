import { create } from 'zustand';

/**
 * Where the sign-in stands, for the screens that need to say so. It never holds a token: the
 * token lives in `session.ts`, and what the connection store sees is an opaque handle.
 */
export type AuthStatus = 'ready' | 'redirecting' | 'signed-out' | 'error';

interface AuthState {
  status: AuthStatus;
  /** The `sub` claim, for display. */
  subject: string | null;
  /** True once an OpenID Connect session owns the credentials (the token prompt is not used). */
  managed: boolean;
  error: string | null;
  setReady: (subject?: string) => void;
  setStatus: (status: AuthStatus) => void;
  setError: (message: string) => void;
  setSignedOut: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  status: 'ready',
  subject: null,
  managed: false,
  error: null,
  setReady: (subject) =>
    set({ status: 'ready', subject: subject ?? null, managed: true, error: null }),
  setStatus: (status) =>
    set({ status, error: null, ...(status === 'redirecting' ? { managed: true } : {}) }),
  setError: (message) => set({ status: 'error', error: message, managed: true }),
  setSignedOut: () => set({ status: 'signed-out', subject: null, error: null, managed: true }),
}));
