import { type FormEvent, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  getAgentAuthHeaders,
  getAuthHeaders,
  getBaseUrl,
  useConnectionStore,
} from '@/components/dashboard/stores/connectionStore';
import {
  mayRestoreModalFocus,
  useGlobalModalStore,
} from '@/components/dashboard/stores/globalModalStore';
import { Button, buttonClass } from '@/components/ui/Button';
import { Field, Input } from '@/components/ui/form';
import { getActiveSession } from '@/lib/auth/activeSession';
import { bq } from '@/lib/bq';
import { cn } from '@/lib/cn';
import { usePresence } from '@/lib/usePresence';

type AuthScope = 'server' | 'agent';
type AuthRequiredDetail = { scope?: AuthScope; auth?: string; target?: string };
interface AuthIdentity {
  scope: AuthScope;
  auth?: string;
  target: string;
}

function currentAuthIdentity(scope: AuthScope): AuthIdentity {
  return {
    scope,
    auth: scope === 'agent' ? getAgentAuthHeaders().Authorization : getAuthHeaders().Authorization,
    target: scope === 'agent' ? bq.agentBase : getBaseUrl(),
  };
}

function sameAuthIdentity(a: AuthIdentity | null, b: AuthIdentity): boolean {
  return a?.scope === b.scope && a.auth === b.auth && a.target === b.target;
}

/**
 * Token lock screen. When any `bq` API call gets a 401 (a bearer token is
 * missing or wrong), `bq.ts` dispatches a scoped `auth:required` window event
 * and this overlay prompts for the right token — the qelay server's token
 * for a server 401, the control agent's AGENT_TOKEN for an agent 401 (prompting
 * for the wrong one can never clear the lock). On submit it stores the token
 * (connection store, session-only, never persisted) and dismisses
 * optimistically; if still rejected, the next poll re-locks. Mounted once in
 * AppLayout.
 */
export function AuthGate() {
  const [locked, setLocked] = useState(false);
  const [scope, setScope] = useState<AuthScope>('server');
  const [value, setValue] = useState('');
  const baseUrl = useConnectionStore((s) => s.baseUrl);
  const setToken = useConnectionStore((s) => s.setToken);
  const setAgentToken = useConnectionStore((s) => s.setAgentToken);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLFormElement>(null);
  const acceptedIdentity = useRef<AuthIdentity | null>(null);
  const draft = useRef<{ identity: AuthIdentity; value: string } | null>(null);
  const activeModal = useGlobalModalStore((state) => state.active);
  const visible = locked && activeModal === 'authentication';
  // The lock stays drawn while it leaves; everything else (focus, inert, the draft) follows `visible` at once.
  const { mounted, leaving } = usePresence(visible);

  // Lock whenever the API reports a 401, remembering which backend rejected us.
  // The request carries the exact Authorization value and backend it used.
  // Compare both with the CURRENT connection so a slow 401 from an old token or
  // old backend cannot relock the gate after the operator has moved on.
  useEffect(() => {
    const onAuth = (e: Event) => {
      const detail = (e as CustomEvent<AuthRequiredDetail>).detail;
      if (detail?.scope !== 'server' && detail?.scope !== 'agent') return;
      const nextIdentity = currentAuthIdentity(detail.scope);
      // Fail closed for legacy/malformed events: accepting a missing target
      // would let a late 401 from another server gate the active connection.
      if (detail.auth !== nextIdentity.auth || detail.target !== nextIdentity.target) return;
      // An OpenID Connect sign-in owns the credentials: renew or sign in again, never prompt
      // for a token to be typed.
      const managed = getActiveSession();
      if (managed && nextIdentity.scope === 'server') {
        void managed.onUnauthorized();
        return;
      }
      if (!sameAuthIdentity(acceptedIdentity.current, nextIdentity)) {
        // A token draft belongs to one exact backend/request identity. Never
        // carry a server secret into an agent prompt (or server A into B).
        draft.current = null;
        setValue('');
      }
      acceptedIdentity.current = nextIdentity;
      // Authentication has the highest modal priority and synchronously
      // replaces any palette/drawer before this gate is rendered.
      useGlobalModalStore.getState().request('authentication');
      setScope(nextIdentity.scope);
      setLocked(true);
      window.dispatchEvent(new window.Event('auth:gate-opened'));
    };
    window.addEventListener('auth:required', onAuth);
    return () => window.removeEventListener('auth:required', onAuth);
  }, []);

  useEffect(
    () => () => {
      useGlobalModalStore.getState().release('authentication');
    },
    []
  );

  // Modal focus contract: hide/inert the app beneath it, move focus inside,
  // cycle Tab, and restore the opener when authentication succeeds.
  useEffect(() => {
    if (!visible) return;
    const opener = document.activeElement as HTMLElement | null;
    const background = document.getElementById('app-shell')
      ? []
      : ['app-nav', 'app-content']
          .map((id) => document.getElementById(id))
          .filter((element): element is HTMLElement => element !== null);
    const previous = background.map((element) => ({
      element,
      inert: element.inert,
      ariaHidden: element.getAttribute('aria-hidden'),
    }));
    for (const element of background) {
      element.inert = true;
      element.setAttribute('aria-hidden', 'true');
    }
    const id = window.requestAnimationFrame(() => inputRef.current?.focus());
    const focusables = () =>
      dialogRef.current
        ? Array.from(
            dialogRef.current.querySelectorAll<HTMLElement>(
              'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'
            )
          )
        : [];
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const items = focusables();
      if (!items.length) {
        event.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.cancelAnimationFrame(id);
      window.removeEventListener('keydown', onKey);
      for (const state of previous) {
        state.element.inert = state.inert;
        if (state.ariaHidden === null) state.element.removeAttribute('aria-hidden');
        else state.element.setAttribute('aria-hidden', state.ariaHidden);
      }
      if (mayRestoreModalFocus('authentication') && opener?.isConnected) opener.focus();
    };
  }, [visible]);

  const dismiss = () => {
    acceptedIdentity.current = null;
    draft.current = null;
    setValue('');
    setLocked(false);
    useGlobalModalStore.getState().release('authentication');
  };

  if (!mounted) return null;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const identity = acceptedIdentity.current;
    const currentDraft = draft.current;
    if (
      !identity ||
      !currentDraft ||
      !sameAuthIdentity(currentDraft.identity, identity) ||
      !sameAuthIdentity(identity, currentAuthIdentity(identity.scope))
    ) {
      // The connection changed while the gate was open, or this render still
      // contains a draft from a superseded prompt. Close without assigning it.
      dismiss();
      return;
    }
    const token = currentDraft.value.trim();
    if (!token) return;
    if (identity.scope === 'agent') setAgentToken(token);
    else setToken(token);
    dismiss(); // optimistic; a still-401 poll re-locks
  };

  return (
    <div
      inert={leaving || undefined}
      className="fixed inset-0 z-[60] flex items-center justify-center p-4"
    >
      {/* Not a button, so there is no click outside to dismiss: only a token or Settings closes the lock. */}
      <div
        aria-hidden="true"
        className={cn('fixed inset-0 bg-scrim', leaving ? 'motion-fade-out' : 'motion-fade')}
      />
      <form
        ref={dialogRef}
        onSubmit={submit}
        role="dialog"
        aria-modal="true"
        aria-label="Authentication required"
        aria-describedby="auth-gate-reason"
        className={cn(
          'relative flex w-full max-w-md flex-col gap-4 rounded-card border border-line-strong bg-raised p-6 shadow-pop',
          leaving ? 'motion-leave' : 'motion-pop'
        )}
      >
        <h2 className="m-0 text-2xl font-bold leading-[1.1] tracking-[-0.03em] text-fg">
          Authentication required
        </h2>
        {scope === 'agent' ? (
          <p id="auth-gate-reason" className="m-0 text-[13px] text-muted">
            The control agent at <span className="break-all font-mono text-fg">{bq.agentBase}</span>{' '}
            rejected the request (401). Enter its{' '}
            <span className="font-mono text-fg">AGENT_TOKEN</span> to continue.
          </p>
        ) : (
          <p id="auth-gate-reason" className="m-0 text-[13px] text-muted">
            The server at <span className="break-all font-mono text-fg">{baseUrl}</span> rejected
            the request (401). Enter its bearer token to continue.
          </p>
        )}
        <Field label={scope === 'agent' ? 'Agent token' : 'Bearer token'}>
          <Input
            ref={inputRef}
            type="password"
            value={value}
            onInput={(e) => {
              const nextValue = e.currentTarget.value;
              setValue(nextValue);
              const identity = acceptedIdentity.current;
              draft.current = identity ? { identity, value: nextValue } : null;
            }}
            placeholder={scope === 'agent' ? 'AGENT_TOKEN' : 'Bearer token'}
            aria-label={scope === 'agent' ? 'Agent token' : 'Bearer token'}
            name={scope === 'agent' ? 'agent-token' : 'server-token'}
            autoComplete="current-password"
          />
        </Field>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Link to="/settings" onClick={dismiss} className={buttonClass('default', 'md')}>
            Open Settings instead
          </Link>
          <Button type="submit" variant="primary" disabled={!value.trim()}>
            Unlock
          </Button>
        </div>
      </form>
    </div>
  );
}
