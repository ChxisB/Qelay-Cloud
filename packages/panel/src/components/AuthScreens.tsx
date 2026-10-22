import type { ReactNode } from 'react';
import { QelayLogo } from '@/components/brand/QelayLogo';
import { Banner } from '@/components/ui/Banner';
import { Button } from '@/components/ui/Button';
import { getActiveSession } from '@/lib/auth/activeSession';
import { useAuthStore } from '@/lib/auth/authStore';

/**
 * One screen is one card on the page, with the brand lockup and the screen's own h1. The card rises once;
 * when the screen changes under it, its text (keyed by the title) fades in again.
 */
function Frame({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-bg p-4">
      <section
        aria-labelledby="auth-title"
        className="motion-arrive flex w-full max-w-md flex-col items-stretch gap-4 rounded-card border border-line bg-surface p-8 text-fg shadow-panel"
      >
        <QelayLogo />
        <div key={title} className="motion-fade flex flex-col items-stretch gap-4">
          <h1
            id="auth-title"
            className="m-0 mt-2 text-[20px] font-bold leading-[1.1] tracking-[-0.03em]"
          >
            {title}
          </h1>
          {children}
        </div>
      </section>
    </main>
  );
}

const TEXT = 'm-0 text-[13px] text-muted';

/** What the page shows while the sign-in is not in a usable state. */
export function SignInScreen() {
  const status = useAuthStore((s) => s.status);
  const error = useAuthStore((s) => s.error);
  const signInAgain = () => void getActiveSession()?.signInAgain();

  if (status === 'redirecting') {
    return (
      <Frame title="Signing you in">
        <p role="status" className={TEXT}>
          Redirecting to your identity provider…
        </p>
        <div aria-hidden="true" className="flex flex-col gap-2.5">
          {['w-full', 'w-[82%]', 'w-[60%]'].map((width) => (
            <span
              key={width}
              className={`block h-3.5 rounded-[8px] bg-slate-tint motion-safe:animate-pulse ${width}`}
            />
          ))}
        </div>
      </Frame>
    );
  }
  if (status === 'signed-out') {
    return (
      <Frame title="You are signed out">
        <p className={TEXT}>Sign in again to use the control panel.</p>
        <Button variant="primary" onClick={signInAgain}>
          Sign in
        </Button>
        <p className="m-0 text-[13px] text-muted">
          Your access token stays in memory for this tab. It is never saved in the browser's storage
          or put in a web address.
        </p>
      </Frame>
    );
  }
  return (
    <Frame title="Sign-in problem">
      <Banner title={error ?? 'Sign-in did not complete.'} />
      <Button variant="primary" onClick={signInAgain}>
        Sign in again
      </Button>
    </Frame>
  );
}

/** `config.json` is there and wrong. Nothing else on the page can be trusted to point anywhere. */
export function ConfigErrorScreen({ message }: { message: string }) {
  return (
    <Frame title="The panel is not configured correctly">
      <div className="break-words">
        <Banner title={message} />
      </div>
      <p className={TEXT}>
        Ask the person who deployed the panel to fix <span className="font-mono">config.json</span>.
      </p>
    </Frame>
  );
}
