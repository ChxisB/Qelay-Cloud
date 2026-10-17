import { getActiveSession } from '@/lib/auth/activeSession';
import { useAuthStore } from '@/lib/auth/authStore';

const card =
  'w-full max-w-md rounded-card border border-line-strong bg-surface p-6 shadow-2xl text-fg';
const button =
  'rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-bg p-4">
      <section className={card}>{children}</section>
    </main>
  );
}

/** What the page shows while the sign-in is not in a usable state. */
export function SignInScreen() {
  const status = useAuthStore((s) => s.status);
  const error = useAuthStore((s) => s.error);
  const signInAgain = () => void getActiveSession()?.signInAgain();

  if (status === 'redirecting') {
    return (
      <Frame>
        <h1 className="text-lg font-semibold">Signing you in</h1>
        <p role="status" className="mt-2 text-sm text-muted">
          Redirecting to your identity provider…
        </p>
      </Frame>
    );
  }
  if (status === 'signed-out') {
    return (
      <Frame>
        <h1 className="text-lg font-semibold">You are signed out</h1>
        <p className="mt-2 text-sm text-muted">Sign in again to use the control panel.</p>
        <button type="button" className={`${button} mt-4`} onClick={signInAgain}>
          Sign in
        </button>
      </Frame>
    );
  }
  return (
    <Frame>
      <h1 className="text-lg font-semibold">Sign-in problem</h1>
      <p role="alert" className="mt-2 text-sm text-muted">
        {error ?? 'Sign-in did not complete.'}
      </p>
      <button type="button" className={`${button} mt-4`} onClick={signInAgain}>
        Sign in again
      </button>
    </Frame>
  );
}

/** `config.json` is there and wrong. Nothing else on the page can be trusted to point anywhere. */
export function ConfigErrorScreen({ message }: { message: string }) {
  return (
    <Frame>
      <h1 className="text-lg font-semibold">The panel is not configured correctly</h1>
      <p role="alert" className="mt-2 break-words text-sm text-muted">
        {message}
      </p>
      <p className="mt-2 text-sm text-muted">
        Ask the person who deployed the panel to fix <span className="font-mono">config.json</span>.
      </p>
    </Frame>
  );
}
